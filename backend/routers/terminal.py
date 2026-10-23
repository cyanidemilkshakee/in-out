"""
Terminal bundle endpoint.

GET /v1/terminal/bundle — returns the small, cacheable terminal bootstrap.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
import uuid
import json
from auth import verify_terminal_access_request
from database import get_db
from data_limits import bounded_rows
from config import settings
from schemas import BrowserScanPayload, ManualReviewPayload
from terminal_scans import record_scan
from event_outbox import enqueue_presence, enqueue_workflow_start
from redis_client import publish_presence_update
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import AccessPermission, AdminAccount, Checkpoint, HardwareAsset, Subject, Person, PermissionRequestModel, Movement
from temporal_worker import get_temporal_client, TASK_QUEUE
from permission_decisions import review_source, require_recent_review_source, pending_manual_review
from access_validation import validate_registered_zones
from facility_zones import normalize_facility_document
from terminal_assignments import assigned_checkpoint, browser_identity, require_checkpoint
from critical_entry_restrictions import entry_restrictions_for_subjects

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/terminal", tags=["terminal"])


@router.post("/scans")
async def scan(payload: BrowserScanPayload,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db), operator: dict = Depends(verify_terminal_access_request),
    request: Request = None):
    identity = browser_identity(operator)
    checkpoint_id = await require_checkpoint(db, identity, payload.checkpoint_id)
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=422, detail="Checkpoint not registered")
    mode = checkpoint.data.get("mode", "auto")
    if mode == "manual" and payload.direction is None:
        raise HTTPException(status_code=422, detail="Choose entry or exit for this manual checkpoint")
    if mode != "manual" and payload.direction is not None:
        raise HTTPException(status_code=422, detail="Scan direction is controlled by the assigned checkpoint")
    result = await record_scan(db, idempotency_key, payload, identity,
                               request_scope=request.scope if request is not None else None)
    if not db.info.get("scan_replayed"):
        event = result["decision"]["event"]
        await enqueue_presence(db, {
            "type": "manual_review_consumed" if result.get("manualApprovalRequest") else "scan",
            "subject_id": result.get("subject_id"),
            "state": ("inside" if event["direction"] == "entry" else "outside") if result["allowed"] else None,
            "movement": event,
            "alerts": db.info.get("scan_alerts", []),
            "people": result.get("updatedPeople", []),
            "hardwareAssets": result.get("updatedHardwareAssets", []),
            "request": result.get("manualApprovalRequest"),
        })
    await db.commit()
    return result


@router.post("/manual-reviews")
async def create_manual_review(
    payload: ManualReviewPayload,
    db: AsyncSession = Depends(get_db),
    _operator: dict = Depends(verify_terminal_access_request),
) -> dict[str, Any]:
    """Place an unregistered barcode in the Permission Manager queue."""
    checkpoint_id = await require_checkpoint(db, browser_identity(_operator), payload.checkpoint_id)
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=422, detail="Checkpoint not registered")
    now = datetime.now(timezone.utc)
    barcode = payload.barcode.strip()
    source = await review_source(db, payload.event_id, barcode, checkpoint.id, payload.direction)
    require_recent_review_source(source, now=now)
    if source.subject_id:
        raise HTTPException(422, "Registered subjects must use the permission request flow")
    registered_subject = await db.scalar(select(Subject.id).where(func.lower(Subject.barcode) == barcode.lower()))
    if registered_subject:
        raise HTTPException(409, "This barcode is now registered; scan it again before requesting review")
    direction = payload.direction or (source.direction if source else None) or ("exit" if checkpoint.data.get("mode") == "exit" else "entry")
    existing = await pending_manual_review(db, barcode, checkpoint.id, direction)
    if existing:
        return existing.data

    request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"
    data = {
        "id": request_id,
        "subjectId": "",
        "subjectType": "visitor",
        "subjectName": "Unregistered barcode",
        "barcode": barcode,
        "requester": _operator.get("sub", "Terminal Operator"),
        "purpose": "Barcode was denied and requires manual permission review.",
        "requestedZones": await validate_registered_zones(db, [checkpoint.zone_id]),
        "validFrom": now.isoformat(),
        "validTo": (now + timedelta(hours=1)).isoformat(),
        "status": "pending",
        "type": "manual_override",
        "direction": direction,
        "checkpointId": checkpoint.id,
        "checkpoint": checkpoint.data.get("name", checkpoint.id),
        "date": now.date().isoformat(),
        "time": now.strftime("%H:%M:%S"),
        "createdAt": now.isoformat(),
    }
    data["eventId"] = payload.event_id
    if payload.operator_note:
        data["operatorNote"] = payload.operator_note
    db.add(PermissionRequestModel(id=request_id, subject_id=data["subjectId"] or None, created_at=now, data=data))
    await enqueue_workflow_start(db, request_id)
    await enqueue_presence(db, {"type": "manual_review", "requestId": request_id, "request": data})
    await db.commit()
    return data


@router.get("/bundle")
async def get_terminal_bundle(
    db: AsyncSession = Depends(get_db),
    operator: dict = Depends(verify_terminal_access_request),
) -> dict[str, Any]:
    """
    Return the data a terminal needs at bootstrap, including visitors with an
    approval or access record for the assigned checkpoint. Scan decisions
    remain server-authoritative; the visitor list is for operator awareness.
    """

    from event_outbox import read_event_revision
    event_revision = await read_event_revision(db)
    checkpoint_id = await assigned_checkpoint(db, browser_identity(operator))

    checkpoint_record = await db.get(Checkpoint, checkpoint_id)
    checkpoint_config = checkpoint_record.data if checkpoint_record else None
    checkpoint_zone = checkpoint_record.zone_id if checkpoint_record and checkpoint_record.active else None

    async def fetch_hardware_assets() -> list[dict[str, Any]]:
        if checkpoint_zone is None:
            return []
        hw_rows = await bounded_rows(db,
            select(HardwareAsset, Subject, AccessPermission)
            .join(Subject, Subject.id == HardwareAsset.subject_id)
            .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        )
        visible_rows = []
        for hw, subject, permission in hw_rows:
            entry = normalize_facility_document(dict(hw.data or {}))
            permission_data = normalize_facility_document(dict(permission.data or {})) if permission else {}
            zones = permission_data.get("zones") if isinstance(permission_data.get("zones"), list) else entry.get("allowedZones")
            if not isinstance(zones, list) and isinstance(entry.get("allowedZone"), str):
                zones = [entry["allowedZone"]]
            if checkpoint_zone in (zones or []):
                visible_rows.append((entry, subject))
        restrictions = await entry_restrictions_for_subjects(db, [subject.id for _, subject in visible_rows])
        assets: list[dict[str, Any]] = []
        for entry, subject in visible_rows:
            entry.update(id=subject.id, kind=subject.kind, barcode=subject.barcode)
            entry["entryRestriction"] = restrictions.get(subject.id)
            assets.append(entry)
        return assets

    async def fetch_checkpoints() -> list[dict[str, Any]]:
        result = await db.execute(select(Checkpoint).where(Checkpoint.id == checkpoint_id))
        return [{**(c.data or {}), "id": c.id} for c in result.scalars().all()]

    hardware_assets = await fetch_hardware_assets()
    checkpoints = await fetch_checkpoints()
    visitor_request_rows = await bounded_rows(db,
        select(PermissionRequestModel)
        .where(PermissionRequestModel.data["type"].astext == "visitor")
        .where(PermissionRequestModel.data["checkpointId"].astext == checkpoint_id)
        .order_by(PermissionRequestModel.created_at.desc()))
    visitor_requests: dict[str, dict[str, Any]] = {}
    for request_row in visitor_request_rows:
        request_data = dict(request_row[0].data or {})
        visitor_id = str(request_row[0].subject_id or request_data.get("subjectId") or "")
        if visitor_id:
            visitor_requests.setdefault(visitor_id, request_data)

    visitor_eligibility = []
    if visitor_requests:
        visitor_eligibility.append(Subject.id.in_(visitor_requests))
    if checkpoint_zone:
        visitor_eligibility.extend((
            and_(
                AccessPermission.data["state"].astext == "active",
                AccessPermission.data["zones"].contains([checkpoint_zone]),
            ),
            Person.data["allowedZones"].contains([checkpoint_zone]),
        ))
    visitor_rows = await bounded_rows(db,
        select(Subject, Person, AccessPermission)
        .join(Person, Person.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(Subject.kind == "visitor")
        .where(or_(*visitor_eligibility) if visitor_eligibility else False)
        .order_by(Subject.id))
    terminal_visitors: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    for subject, person, permission in visitor_rows:
        metadata = normalize_facility_document(dict(person.data or {}))
        permission_data = normalize_facility_document(dict(permission.data or {})) if permission else {}
        registration_request = visitor_requests.get(subject.id)
        request_zones = registration_request.get("requestedZones") if registration_request else []
        permission_zones = permission_data.get("zones") if isinstance(permission_data.get("zones"), list) else []
        zones = permission_zones or metadata.get("allowedZones") or request_zones
        if not isinstance(zones, list):
            zones = []
        zones = [zone for zone in zones if isinstance(zone, str)]
        permission_state = permission_data.get("state")
        if not registration_request and not (permission_state == "active" and checkpoint_zone in zones):
            continue

        valid_from = permission_data.get("validFrom") or metadata.get("validFrom") or (registration_request or {}).get("validFrom")
        valid_to = permission_data.get("validTo") or metadata.get("validTo") or (registration_request or {}).get("validTo")
        expired = False
        if isinstance(valid_to, str) and valid_to:
            try:
                expiry = datetime.fromisoformat(valid_to.replace("Z", "+00:00"))
                if expiry.tzinfo is None:
                    expiry = expiry.replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
                expired = expiry <= now
            except ValueError:
                pass
        request_status = (registration_request or {}).get("status")
        if request_status == "pending" or permission_state == "pending_approval":
            visitor_status = "pending"
        elif request_status == "denied" and permission_state != "active":
            visitor_status = "denied"
        elif permission_state == "restricted":
            visitor_status = "restricted"
        elif permission_state == "revoked":
            visitor_status = "inactive"
        elif permission_state == "expired" or expired:
            visitor_status = "expired"
        elif permission_state == "active" or request_status == "approved":
            visitor_status = "approved"
        else:
            visitor_status = "inactive"

        terminal_visitors.append({
            "id": subject.id,
            "name": str(metadata.get("name") or subject.barcode),
            "barcode": subject.barcode,
            "host": metadata.get("host") if isinstance(metadata.get("host"), str) else "",
            "company": metadata.get("company") if isinstance(metadata.get("company"), str) else "",
            "allowedZones": zones,
            "validFrom": valid_from if isinstance(valid_from, str) else "",
            "validTo": valid_to if isinstance(valid_to, str) else "",
            "createdAt": metadata.get("createdAt") if isinstance(metadata.get("createdAt"), str) else "",
            "status": visitor_status,
        })
    terminal_visitors.sort(key=lambda visitor: visitor.get("createdAt") or "", reverse=True)

    review_result = await db.execute(
        select(PermissionRequestModel)
        .where(PermissionRequestModel.data["checkpointId"].astext == checkpoint_id)
        .where(PermissionRequestModel.data["type"].astext == "manual_override")
        # Dismissal hides only the notification; recent decision history stays
        # available to Terminal Activity after a refresh or sign-in.
        .order_by(PermissionRequestModel.created_at.desc())
        .limit(20)
    )
    permission_requests = [request.data for request in review_result.scalars().all()]
    movement_result = await db.execute(
        select(Movement)
        .where(Movement.checkpoint_id == checkpoint_id)
        .order_by(Movement.occurred_at.desc(), Movement.id)
        .limit(20)
    )
    movements = [
        {
            "id": movement.id,
            "subject_id": movement.subject_id,
            "checkpoint_id": movement.checkpoint_id,
            "occurred_at": movement.occurred_at.isoformat() if movement.occurred_at else None,
            "denial_code": movement.denial_code,
            "result": movement.result,
            "direction": movement.direction,
            "scan_type": movement.scan_type,
            "subject_type": movement.subject_type,
            "sync_state": movement.sync_state,
            "data": movement.data,
        }
        for movement in movement_result.scalars().all()
    ]
    offline_until = await db.scalar(
        select(AdminAccount.offline_until)
        .where(AdminAccount.offline_until.is_not(None), AdminAccount.offline_until > datetime.now(timezone.utc))
        .order_by(AdminAccount.offline_until.asc())
        .limit(1)
    )

    return {
        "eventRevision": event_revision,
        "terminalReplayPolicy": {
            "receiptRetentionDays": settings.IDEMPOTENCY_RETENTION_DAYS,
            "serverTime": datetime.now(timezone.utc).isoformat(),
        },
        "hardwareAssets": hardware_assets,
        "terminalVisitors": terminal_visitors,
        "checkpoints": checkpoints,
        "terminalAssignment": {"operatorSubject": operator["sub"], "checkpointId": checkpoint_id},
        "movements":   movements,
        "permissionRequests": permission_requests,
        "adminAvailability": {
            "status": "offline" if offline_until else "available",
            "availableAt": offline_until.isoformat() if offline_until else None,
        },
    }
