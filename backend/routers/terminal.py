"""
Terminal bundle endpoint.

GET /v1/terminal/bundle — returns the small, cacheable terminal bootstrap.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
import uuid
from auth import verify_terminal_access_request
from database import get_db
from data_limits import bounded_rows, precharge_mutation_response
from config import settings
from schemas import BrowserScanPayload, ManualReviewPayload
from terminal_scans import record_scan
from event_outbox import enqueue_presence, enqueue_workflow_start
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import AccessPermission, AdminAccount, Checkpoint, HardwareAsset, Subject, PermissionRequestModel, Movement
from permission_decisions import review_source, require_recent_review_source, pending_manual_review
from access_validation import validate_registered_zones
from facility_zones import normalize_facility_document
from terminal_assignments import assigned_checkpoint, browser_identity, require_checkpoint
from critical_entry_restrictions import entry_restrictions_for_subjects
from terminal_visitors import terminal_visitors_page

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
    await precharge_mutation_response(db, result)
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
        await precharge_mutation_response(db, existing.data)
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
    await precharge_mutation_response(db, data)
    await db.commit()
    return data


@router.get("/bundle")
async def get_terminal_bundle(
    db: AsyncSession = Depends(get_db),
    operator: dict = Depends(verify_terminal_access_request),
) -> dict[str, Any]:
    """
    Return checkpoint settings and bounded recent activity needed at bootstrap.
    The potentially large visitor roster is loaded through its own cursor page.
    """

    from event_outbox import read_event_revision
    event_revision = await read_event_revision(db)
    checkpoint_id = await assigned_checkpoint(db, browser_identity(operator))

    checkpoint_record = await db.get(Checkpoint, checkpoint_id)
    checkpoint_config = checkpoint_record.data if checkpoint_record else None
    checkpoint_zone = checkpoint_record.zone_id if checkpoint_record else None

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
        "terminalVisitors": [],
        "terminalVisitorsHasMore": True,
        "checkpoints": checkpoints,
        "terminalAssignment": {"operatorSubject": operator["sub"], "checkpointId": checkpoint_id},
        "movements":   movements,
        "permissionRequests": permission_requests,
        "adminAvailability": {
            "status": "offline" if offline_until else "available",
            "availableAt": offline_until.isoformat() if offline_until else None,
        },
    }


@router.get("/visitors")
async def get_terminal_visitors(
    cursor: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    operator: dict = Depends(verify_terminal_access_request),
) -> dict[str, Any]:
    """Load the assigned checkpoint's visitor roster independently of history."""
    if limit < 1 or limit > 200:
        raise HTTPException(422, "Visitor page size must be between 1 and 200")
    if cursor is not None and (not cursor or len(cursor) > 200):
        raise HTTPException(422, "Visitor cursor is invalid")
    checkpoint_id = await assigned_checkpoint(db, browser_identity(operator))
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    return await terminal_visitors_page(db, checkpoint_id, checkpoint, cursor=cursor, limit=limit)
