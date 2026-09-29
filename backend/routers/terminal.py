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
from auth import verify_terminal_operator_request
from database import get_db
from schemas import BrowserScanPayload, ManualReviewPayload
from terminal_scans import record_scan
from redis_client import publish_presence_update
from dashboard_cache import invalidate_dashboard_cache
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import Checkpoint, HardwareAsset, Subject, PermissionRequestModel, Movement
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow
from permission_decisions import review_source, pending_manual_review

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/terminal", tags=["terminal"])


@router.post("/scans")
async def scan(payload: BrowserScanPayload,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db), operator: dict = Depends(verify_terminal_operator_request)):
    result = await record_scan(db, idempotency_key, payload, "browser:" + operator["sub"])
    await db.commit()
    await invalidate_dashboard_cache()
    try:
        event = result["decision"]["event"]
        await publish_presence_update(json.dumps({
            "type": "scan",
            "subject_id": result.get("subject_id"),
            "state": ("inside" if event["direction"] == "entry" else "outside") if result["allowed"] else None,
            "movement": event,
            "people": result.get("updatedPeople", []),
            "hardwareAssets": result.get("updatedHardwareAssets", []),
        }))
    except Exception:
        logger.exception("Presence publication failed after scan commit")
    return result


@router.post("/manual-reviews")
async def create_manual_review(
    payload: ManualReviewPayload,
    db: AsyncSession = Depends(get_db),
    _operator: dict = Depends(verify_terminal_operator_request),
) -> dict[str, Any]:
    """Place an unregistered barcode in the Permission Manager queue."""
    checkpoint = await db.get(Checkpoint, payload.checkpoint_id)
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
        "requestedZones": [checkpoint.data.get("zone", checkpoint.id)],
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
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Return the data a terminal needs at bootstrap. People and their presence
    are deliberately excluded: scan decisions are always made by the server,
    while the terminal needs hardware metadata for its selector and offline
    queue configuration.
    """

    async def fetch_hardware_assets() -> list[dict[str, Any]]:
        hw_res = await db.execute(
            select(HardwareAsset, Subject)
            .join(Subject, Subject.id == HardwareAsset.subject_id)
        )
        hw_rows = hw_res.all()
        assets: list[dict[str, Any]] = []
        for hw, subject in hw_rows:
            entry = dict(hw.data or {})
            entry.update(id=subject.id, kind=subject.kind, barcode=subject.barcode)
            assets.append(entry)
        return assets

    async def fetch_checkpoints() -> list[dict[str, Any]]:
        result = await db.execute(select(Checkpoint).order_by(Checkpoint.id))
        return [{**c.data, "id": c.id} for c in result.scalars().all()]

    hardware_assets = await fetch_hardware_assets()
    checkpoints = await fetch_checkpoints()
    review_result = await db.execute(
        select(PermissionRequestModel)
        .where(PermissionRequestModel.data["type"].astext == "manual_override")
        .where(PermissionRequestModel.data["status"].astext == "pending")
        .order_by(PermissionRequestModel.created_at.desc())
        .limit(20)
    )
    permission_requests = [request.data for request in review_result.scalars().all()]
    movement_result = await db.execute(
        select(Movement)
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

    return {
        "hardwareAssets": hardware_assets,
        "checkpoints": checkpoints,
        "movements":   movements,
        "permissionRequests": permission_requests,
    }
