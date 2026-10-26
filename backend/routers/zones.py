"""Organization-zone administration for the master-admin role."""
from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from auth import has_master_admin_role, verify_admin_request
from database import get_db
from event_outbox import enqueue_changed
from models import (
    AuditEvent, Checkpoint, OrganizationZone, PermissionRequestModel, PresenceState,
    TerminalCheckpointAssignment, ZoneAdminAssignment,
)
from user_management_locks import get_window_guard_db, require_unlocked_window
from user_management_step_up import verified_user_management_window
from zone_access import admin_zone_ids

router = APIRouter(prefix="/v1/zones", tags=["organization zones"])
_bearer = HTTPBearer(auto_error=False)
_ZONE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class ZoneCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if not value or not any(character.isalnum() for character in value):
            raise ValueError("Zone name must contain a letter or number")
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Zone name contains unsupported control characters")
        return value


async def _master_admin_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    step_up: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
    guard_db: AsyncSession = Depends(get_window_guard_db),
) -> dict[str, Any]:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    actor = await verify_admin_request(credentials, request)
    if not has_master_admin_role(actor):
        raise HTTPException(status_code=403, detail="Only a master-admin can manage organization zones")
    window = verified_user_management_window(credentials.credentials, actor, step_up, now=time.time())
    await require_unlocked_window(guard_db, actor, window)
    return actor


def _zone_id(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")[:48].rstrip("-")
    if value.startswith("zone-"):
        value = value[5:]
    if not value or not _ZONE_ID.fullmatch(value):
        raise HTTPException(status_code=422, detail="Zone name must produce a valid zone ID")
    return value


def _zone_audit(zone: OrganizationZone, actor: dict[str, Any], action: str, now: datetime) -> AuditEvent:
    event_id = str(uuid.uuid4())
    return AuditEvent(id=event_id, created_at=now, data={
        "id": event_id,
        "category": "system",
        "action": action,
        "subjectId": zone.id,
        "subjectName": zone.name,
        "zoneId": zone.id,
        "actor": actor.get("sub", "unknown"),
        "role": "master-admin",
        "reason": "Organization zone configuration changed",
        "date": now.date().isoformat(),
        "time": now.strftime("%H:%M:%S"),
        "createdAt": now.isoformat(),
    })


@router.get("")
async def list_zones(
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    scope = await admin_zone_ids(db, actor)
    rows = await db.scalars(select(OrganizationZone).where(
        OrganizationZone.active.is_(True), OrganizationZone.id.in_(scope)).order_by(OrganizationZone.name))
    zones = list(rows)
    if not zones:
        return []
    checkpoints = await db.scalars(select(Checkpoint).where(
        Checkpoint.active.is_(True), Checkpoint.zone_id.in_([zone.id for zone in zones]))
        .order_by(Checkpoint.zone_id, Checkpoint.number))
    by_zone: dict[str, list[dict[str, Any]]] = {zone.id: [] for zone in zones}
    for checkpoint in checkpoints:
        by_zone[checkpoint.zone_id].append({
            **(checkpoint.data or {}), "id": checkpoint.id, "zoneId": checkpoint.zone_id,
            "number": checkpoint.number, "gateType": checkpoint.gate_type,
            "required": checkpoint.required, "active": checkpoint.active,
        })
    return [{"id": zone.id, "name": zone.name, "active": zone.active,
        "checkpoints": by_zone[zone.id]} for zone in zones]


@router.post("", status_code=201)
async def create_zone(
    payload: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(_master_admin_context),
) -> dict[str, Any]:
    zone_id = _zone_id(payload.name)
    try:
        await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("organization-zone-registry", 0))))
        duplicate_name = await db.scalar(select(OrganizationZone.id).where(
            func.lower(OrganizationZone.name) == payload.name.casefold()).limit(1))
        if duplicate_name or await db.get(OrganizationZone, zone_id) is not None:
            raise HTTPException(status_code=409, detail="A zone with this name or ID already exists")
        now = datetime.now(timezone.utc)
        zone = OrganizationZone(id=zone_id, name=payload.name, active=True, created_by=actor.get("sub"))
        db.add(zone)
        for number, gate_type, gate_label, required in (
            (1, "front_gate", "Front Gate", True),
            (2, "back_gate", "Back Gate", False),
        ):
            checkpoint_id = f"{zone_id}-{number}"
            db.add(Checkpoint(id=checkpoint_id, zone_id=zone_id, number=number,
                gate_type=gate_type, required=required, active=True, data={
                    "name": str(number), "mode": "auto", "zone": zone_id, "zoneId": zone_id,
                    "buildingId": zone_id, "checkpointNumber": number, "gateType": gate_type,
                    "gateLabel": gate_label, "required": required, "active": True,
                    "online": True, "createdAt": now.isoformat(),
                }))
        db.add(_zone_audit(zone, actor, "zone_created", now))
        await db.flush()
        await enqueue_changed(db)
        await db.commit()
        return {"id": zone.id, "name": zone.name, "active": True, "checkpoints": [
            {"id": f"{zone.id}-1", "number": 1, "name": "1", "mode": "auto", "zone": zone.id,
                "zoneId": zone.id, "buildingId": zone.id, "gateType": "front_gate", "gateLabel": "Front Gate",
                "required": True, "active": True, "online": True, "createdAt": now.isoformat()},
            {"id": f"{zone.id}-2", "number": 2, "name": "2", "mode": "auto", "zone": zone.id,
                "zoneId": zone.id, "buildingId": zone.id, "gateType": "back_gate", "gateLabel": "Back Gate",
                "required": False, "active": True, "online": True, "createdAt": now.isoformat()},
        ]}
    except HTTPException:
        await db.rollback()
        raise
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Zone or its default checkpoint IDs already exist") from error
    except Exception:
        await db.rollback()
        raise


@router.delete("/{zone_id}", status_code=204)
async def delete_zone(
    zone_id: str,
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(_master_admin_context),
) -> None:
    """Retire a branch and its checkpoints while preserving historical records."""
    zone = await db.scalar(select(OrganizationZone).where(
        OrganizationZone.id == zone_id).with_for_update())
    if zone is None or not zone.active:
        raise HTTPException(status_code=404, detail="Organization zone not found")
    assigned_operator = await db.scalar(select(TerminalCheckpointAssignment.terminal_identity)
        .join(Checkpoint, Checkpoint.id == TerminalCheckpointAssignment.checkpoint_id)
        .where(Checkpoint.zone_id == zone_id).limit(1))
    if assigned_operator:
        raise HTTPException(status_code=409, detail="Reassign operators before deleting this zone")
    inside_subject = await db.scalar(select(PresenceState.subject_id).where(
        PresenceState.state == "inside", PresenceState.entry_building_id == zone_id).limit(1))
    if inside_subject:
        raise HTTPException(status_code=409, detail="Complete active visits before deleting this zone")
    pending_request = await db.scalar(select(PermissionRequestModel.id).where(
        PermissionRequestModel.data["status"].astext == "pending",
        PermissionRequestModel.data["requestedZones"].contains([zone_id])).limit(1))
    if pending_request:
        raise HTTPException(status_code=409, detail="Resolve pending permissions before deleting this zone")

    now = datetime.now(timezone.utc)
    zone.active = False
    checkpoints = await db.scalars(select(Checkpoint).where(Checkpoint.zone_id == zone_id))
    for checkpoint in checkpoints:
        checkpoint.active = False
        checkpoint.data = {**(checkpoint.data or {}), "active": False}
    assignments = await db.scalars(select(ZoneAdminAssignment).where(ZoneAdminAssignment.zone_id == zone_id))
    for assignment in assignments:
        await db.delete(assignment)
    db.add(_zone_audit(zone, actor, "zone_deleted", now))
    await enqueue_changed(db)
    await db.commit()
