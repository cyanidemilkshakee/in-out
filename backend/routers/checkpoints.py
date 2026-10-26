"""Branch-scoped checkpoint management with step-up and durable audit events."""
from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from auth import has_admin_role, verify_admin_request
from database import get_db
from event_outbox import enqueue_changed
from models import AuditEvent, Checkpoint, OrganizationZone, PermissionRequestModel, TerminalCheckpointAssignment
from user_management_locks import get_window_guard_db, require_unlocked_window
from user_management_step_up import verified_user_management_window
from zone_access import admin_zone_ids, require_checkpoint_scope, require_zone_scope

router = APIRouter(prefix="/v1/checkpoints", tags=["checkpoints"])
_bearer = HTTPBearer(auto_error=False)
_MAX_CHECKPOINTS_PER_ZONE = 100
_CHECKPOINT_NAME = re.compile(r"^[^\x00-\x1f\x7f]+$")


class CheckpointCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True, extra="forbid")
    zone_id: str = Field(alias="zoneId", min_length=1, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(default="2", min_length=1, max_length=80)
    preset: Literal["back_gate", "custom"] = "custom"
    mode: Literal["auto", "manual", "entry", "exit"] = "auto"

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if not _CHECKPOINT_NAME.fullmatch(value):
            raise ValueError("Checkpoint name contains unsupported control characters")
        return value


async def _checkpoint_admin_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    step_up: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
    guard_db: AsyncSession = Depends(get_window_guard_db),
) -> dict[str, Any]:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    actor = await verify_admin_request(credentials, request)
    if not has_admin_role(actor):
        raise HTTPException(status_code=403, detail="Administrator access is required")
    window = verified_user_management_window(credentials.credentials, actor, step_up, now=time.time())
    await require_unlocked_window(guard_db, actor, window)
    return actor


def _checkpoint_document(checkpoint: Checkpoint) -> dict[str, Any]:
    return {
        **(checkpoint.data or {}),
        "id": checkpoint.id,
        "zone": checkpoint.zone_id,
        "zoneId": checkpoint.zone_id,
        "number": checkpoint.number,
        "gateType": checkpoint.gate_type,
        "required": checkpoint.required,
        "active": checkpoint.active,
    }


def _audit(checkpoint_id: str, name: str, zone_id: str, actor: dict[str, Any], action: str, now: datetime) -> AuditEvent:
    event_id = str(uuid.uuid4())
    return AuditEvent(id=event_id, created_at=now, data={
        "id": event_id,
        "category": "system",
        "action": action,
        "subjectId": checkpoint_id,
        "subjectName": name,
        "zoneId": zone_id,
        "actor": actor.get("sub", "unknown"),
        "role": "master-admin" if "master-admin" in (actor.get("realm_access", {}).get("roles") or []) else "admin",
        "reason": "Checkpoint configuration changed",
        "date": now.date().isoformat(),
        "time": now.strftime("%H:%M:%S"),
        "createdAt": now.isoformat(),
    })


@router.get("")
async def list_checkpoints(
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    """List active checkpoints only within the caller's assigned branches."""
    zones = await admin_zone_ids(db, actor)
    if not zones:
        return []
    rows = await db.scalars(
        select(Checkpoint).where(Checkpoint.active.is_(True), Checkpoint.zone_id.in_(zones))
        .order_by(Checkpoint.zone_id, Checkpoint.number)
    )
    return [_checkpoint_document(checkpoint) for checkpoint in rows]


@router.post("", status_code=201)
async def create_checkpoint(
    payload: CheckpointCreate,
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(_checkpoint_admin_context),
) -> dict[str, Any]:
    """Create a non-required checkpoint inside an assigned branch."""
    zone = await require_zone_scope(db, actor, payload.zone_id)
    try:
        await db.execute(select(func.pg_advisory_xact_lock(
            func.hashtextextended(f"checkpoint-registry:{zone.id}", 0)))
        )
        count = int(await db.scalar(select(func.count(Checkpoint.id)).where(
            Checkpoint.zone_id == zone.id, Checkpoint.active.is_(True))) or 0)
        if count >= _MAX_CHECKPOINTS_PER_ZONE:
            raise HTTPException(status_code=409, detail="This zone has reached its checkpoint limit")

        if payload.preset == "back_gate":
            number, name, gate_type, label = 2, "2", "back_gate", "Back Gate"
            existing = await db.scalar(select(Checkpoint).where(
                Checkpoint.zone_id == zone.id, Checkpoint.number == number).with_for_update())
            if existing:
                if existing.active:
                    raise HTTPException(status_code=409, detail="This zone already has checkpoint 2")
                existing.active = True
                existing.data = {**(existing.data or {}), "active": True}
                now = datetime.now(timezone.utc)
                db.add(_audit(existing.id, name, zone.id, actor, "checkpoint_restored", now))
                await db.flush()
                await enqueue_changed(db)
                await db.commit()
                return _checkpoint_document(existing)
        else:
            number = int(await db.scalar(select(func.max(Checkpoint.number)).where(
                Checkpoint.zone_id == zone.id)) or 2) + 1
            name, gate_type, label = payload.name, "custom", ""
            duplicate = await db.scalar(select(Checkpoint.id).where(
                Checkpoint.zone_id == zone.id,
                func.lower(Checkpoint.data["name"].astext) == name.casefold(),
                Checkpoint.active.is_(True),
            ).limit(1))
            if duplicate:
                raise HTTPException(status_code=409, detail="A checkpoint with this name already exists in the zone")

        checkpoint_id = f"{zone.id}-{number}"
        if await db.get(Checkpoint, checkpoint_id) is not None:
            raise HTTPException(status_code=409, detail="That checkpoint number is already retained in history")
        now = datetime.now(timezone.utc)
        data = {
            "name": name,
            "mode": payload.mode,
            "zone": zone.id,
            "zoneId": zone.id,
            "buildingId": zone.id,
            "checkpointNumber": number,
            "gateType": gate_type,
            "gateLabel": label,
            "required": False,
            "active": True,
            "online": True,
            "createdAt": now.isoformat(),
        }
        checkpoint = Checkpoint(id=checkpoint_id, zone_id=zone.id, number=number,
            gate_type=gate_type, required=False, active=True, data=data)
        db.add(checkpoint)
        db.add(_audit(checkpoint_id, name, zone.id, actor, "checkpoint_created", now))
        await db.flush()
        await enqueue_changed(db)
        await db.commit()
        return _checkpoint_document(checkpoint)
    except HTTPException:
        await db.rollback()
        raise
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Checkpoint number is already used in this zone") from error
    except Exception:
        await db.rollback()
        raise


@router.delete("/{checkpoint_id}", status_code=204)
async def delete_checkpoint(
    checkpoint_id: str,
    db: AsyncSession = Depends(get_db),
    actor: dict[str, Any] = Depends(_checkpoint_admin_context),
) -> None:
    """Retire a checkpoint without deleting movement evidence or reusing its number."""
    checkpoint = await require_checkpoint_scope(db, actor, checkpoint_id)
    if checkpoint.required:
        raise HTTPException(status_code=409, detail="Checkpoint 1 (Front Gate) is required and cannot be deleted")
    assigned = await db.scalar(select(TerminalCheckpointAssignment.terminal_identity).where(
        TerminalCheckpointAssignment.checkpoint_id == checkpoint_id).limit(1))
    if assigned:
        raise HTTPException(status_code=409, detail="Reassign terminals before deleting this checkpoint")
    pending = await db.scalar(select(PermissionRequestModel.id).where(
        PermissionRequestModel.data["checkpointId"].astext == checkpoint_id,
        PermissionRequestModel.data["status"].astext == "pending").limit(1))
    if pending:
        raise HTTPException(status_code=409, detail="Resolve pending permission requests before deleting this checkpoint")

    now = datetime.now(timezone.utc)
    checkpoint.active = False
    checkpoint.data = {**(checkpoint.data or {}), "active": False}
    db.add(_audit(checkpoint.id, checkpoint.data.get("name", checkpoint.id), checkpoint.zone_id,
        actor, "checkpoint_deleted", now))
    await enqueue_changed(db)
    await db.commit()
