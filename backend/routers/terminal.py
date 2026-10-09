"""
Terminal bundle endpoint.

GET /v1/terminal/bundle — returns the small, cacheable terminal bootstrap.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
import uuid
import json
from auth import verify_terminal_access_request
from database import get_db
from schemas import BrowserScanPayload, ManualReviewPayload
from terminal_scans import record_scan
from redis_client import publish_presence_update
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import AdminAccount, Checkpoint, HardwareAsset, Subject, PermissionRequestModel, Movement
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow
from permission_decisions import review_source, pending_manual_review
from access_validation import validate_zones
from terminal_assignments import assigned_checkpoint, browser_identity, require_checkpoint
from critical_entry_restrictions import entry_restrictions_for_subjects

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/terminal", tags=["terminal"])


@router.post("/scans")
async def scan(payload: BrowserScanPayload,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db), operator: dict = Depends(verify_terminal_access_request)):
    identity = browser_identity(operator)
    await require_checkpoint(db, identity, payload.checkpoint_id)
    result = await record_scan(db, idempotency_key, payload, identity)
    await db.commit()
    if db.info.get("scan_replayed"):
        return result
    try:
        event = result["decision"]["event"]
        await publish_presence_update(json.dumps({
            "type": "manual_review_consumed" if result.get("manualApprovalRequest") else "scan",
            "subject_id": result.get("subject_id"),
            "state": ("inside" if event["direction"] == "entry" else "outside") if result["allowed"] else None,
            "movement": event,
            "alerts": db.info.get("scan_alerts", []),
            "people": result.get("updatedPeople", []),
            "hardwareAssets": result.get("updatedHardwareAssets", []),
            "request": result.get("manualApprovalRequest"),
        }))
    except Exception:
        logger.exception("Presence publication failed after scan commit")
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
    direction = payload.direction or (source.direction if source else None) or ("exit" if checkpoint.data.get("mode") == "exit" else "entry")
    existing = await pending_manual_review(db, barcode, checkpoint.id, direction)
    if existing:
        return existing.data

    request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"
    data = {
        "id": request_id,
        "subjectId": source.subject_id if source and source.subject_id else "",
        "subjectType": "visitor",
        "subjectName": "Unregistered barcode",
        "barcode": barcode,
        "requester": _operator.get("sub", "Terminal Operator"),
        "purpose": "Barcode was denied and requires manual permission review.",
        "requestedZones": validate_zones([checkpoint.data.get("zone", checkpoint.id)]),
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
    if payload.event_id:
        data["eventId"] = payload.event_id
    if payload.operator_note:
        data["operatorNote"] = payload.operator_note
    db.add(PermissionRequestModel(id=request_id, subject_id=data["subjectId"] or None, created_at=now, data=data))
    await db.commit()

    try:
        client = await get_temporal_client()
        await client.start_workflow(
            PermissionOverrideWorkflow.run,
            args=[request_id],
            id=f"override-{request_id}",
            task_queue=TASK_QUEUE,
        )
    except Exception:
        logger.exception("Failed to start PermissionOverrideWorkflow for barcode review")

    try:
        await publish_presence_update(json.dumps({
            "type": "manual_review",
            "requestId": request_id,
            "request": data,
        }))
    except Exception:
        logger.exception("Manual review presence publication failed")
    return data


@router.get("/bundle")
async def get_terminal_bundle(
    db: AsyncSession = Depends(get_db),
    operator: dict = Depends(verify_terminal_access_request),
) -> dict[str, Any]:
    """
    Return the data a terminal needs at bootstrap. People and their presence
    are deliberately excluded: scan decisions are always made by the server,
    while the terminal needs hardware metadata for its selector and offline
    queue configuration.
    """

    checkpoint_id = await assigned_checkpoint(db, browser_identity(operator))

    async def fetch_hardware_assets() -> list[dict[str, Any]]:
        hw_res = await db.execute(
            select(HardwareAsset, Subject)
            .join(Subject, Subject.id == HardwareAsset.subject_id)
        )
        hw_rows = hw_res.all()
        restrictions = await entry_restrictions_for_subjects(db, [subject.id for _, subject in hw_rows])
        assets: list[dict[str, Any]] = []
        for hw, subject in hw_rows:
            entry = dict(hw.data or {})
            entry.update(id=subject.id, kind=subject.kind, barcode=subject.barcode)
            entry["entryRestriction"] = restrictions.get(subject.id)
            assets.append(entry)
        return assets

    async def fetch_checkpoints() -> list[dict[str, Any]]:
        result = await db.execute(select(Checkpoint).where(Checkpoint.id == checkpoint_id))
        return [{**c.data, "id": c.id} for c in result.scalars().all()]

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
        "hardwareAssets": hardware_assets,
        "checkpoints": checkpoints,
        "terminalAssignment": {"operatorSubject": operator["sub"], "checkpointId": checkpoint_id},
        "movements":   movements,
        "permissionRequests": permission_requests,
        "adminAvailability": {
            "status": "offline" if offline_until else "available",
            "availableAt": offline_until.isoformat() if offline_until else None,
        },
    }
