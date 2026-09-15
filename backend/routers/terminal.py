"""
Terminal bundle endpoint.

GET /v1/terminal/bundle — returns subjects, checkpoints, and presence states
in parallel for terminal bootstrap.
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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import Checkpoint, Person, HardwareAsset, Subject, PresenceState, PermissionRequestModel, Movement
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/terminal", tags=["terminal"])


@router.post("/scans")
async def scan(payload: BrowserScanPayload,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db), operator: dict = Depends(verify_terminal_operator_request)):
    result = await record_scan(db, idempotency_key, payload, "browser:" + operator["sub"])
    await db.commit()
    try:
        event = result["decision"]["event"]
        if result["allowed"]:
            await publish_presence_update(json.dumps({"subject_id": event["subjectId"],
                "state": "inside" if event["direction"] == "entry" else "outside"}))
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
    pending = await db.execute(
        select(PermissionRequestModel)
        .where(PermissionRequestModel.data["type"].astext == "manual_override")
        .order_by(PermissionRequestModel.created_at.desc())
        .limit(200)
    )
    existing = next(
        (
            request for request in pending.scalars().all()
            if request.data.get("status") == "pending"
            and str(request.data.get("barcode", "")).casefold() == barcode.casefold()
        ),
        None,
    )
    if existing:
        return existing.data

    request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"
    direction = payload.direction or ("exit" if checkpoint.data.get("mode") == "exit" else "entry")
    data = {
        "id": request_id,
        "subjectId": "",
        "subjectType": "visitor",
        "subjectName": "Unregistered barcode",
        "barcode": barcode,
        "requester": "Terminal Operator",
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
    db.add(PermissionRequestModel(id=request_id, subject_id=None, created_at=now, data=data))
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
        await publish_presence_update(json.dumps({"type": "manual_review", "requestId": request_id}))
    except Exception:
        logger.exception("Manual review presence publication failed")
    return data


@router.get("/bundle")
async def get_terminal_bundle(
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Fetch all subjects (people + hardware), checkpoints, and presence states
    in parallel and return a compact bundle for terminal initialisation.
    """

    async def fetch_subjects() -> list[dict[str, Any]]:
        # Fetch people
        people_res = await db.execute(
            select(Person, Subject)
            .join(Subject, Subject.id == Person.subject_id)
        )
        people_rows = people_res.all()

        # Fetch hardware
        hw_res = await db.execute(
            select(HardwareAsset, Subject)
            .join(Subject, Subject.id == HardwareAsset.subject_id)
        )
        hw_rows = hw_res.all()

        subjects: list[dict[str, Any]] = []
        for person, subject in people_rows:
            entry = dict(person.data or {})
            entry.setdefault("id", subject.id)
            entry.setdefault("kind", subject.kind)
            entry.setdefault("barcode", subject.barcode)
            subjects.append(entry)

        for hw, subject in hw_rows:
            entry = dict(hw.data or {})
            entry.setdefault("id", subject.id)
            entry.setdefault("kind", subject.kind)
            entry.setdefault("barcode", subject.barcode)
            subjects.append(entry)

        return subjects

    async def fetch_checkpoints() -> list[dict[str, Any]]:
        result = await db.execute(select(Checkpoint).order_by(Checkpoint.id))
        return [{**c.data, "id": c.id} for c in result.scalars().all()]

    async def fetch_presence() -> list[dict[str, Any]]:
        result = await db.execute(
            select(PresenceState, Subject)
            .join(Subject, Subject.id == PresenceState.subject_id)
        )
        rows = result.all()
        presence_list = []
        for ps, subject in rows:
            presence_list.append({
                "subjectId": ps.subject_id,
                "kind":      subject.kind,
                "barcode":   subject.barcode,
                "state":     ps.state,
                "lastScanTimestamp": (
                    ps.last_scan_timestamp.isoformat()
                    if ps.last_scan_timestamp else None
                ),
                "updatedAt": ps.updated_at.isoformat() if ps.updated_at else None,
            })
        return presence_list

    subjects = await fetch_subjects()
    checkpoints = await fetch_checkpoints()
    presence = await fetch_presence()
    review_result = await db.execute(
        select(PermissionRequestModel)
        .where(PermissionRequestModel.data["type"].astext == "manual_override")
        .order_by(PermissionRequestModel.created_at.desc())
        .limit(40)
    )
    permission_requests = [request.data for request in review_result.scalars().all()]
    movement_result = await db.execute(
        select(Movement)
        .order_by(Movement.occurred_at.desc(), Movement.id)
        .limit(40)
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
        "subjects":    subjects,
        "checkpoints": checkpoints,
        "presence":    presence,
        "movements":   movements,
        "permissionRequests": permission_requests,
    }
