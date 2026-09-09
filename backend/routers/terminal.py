"""
Terminal bundle endpoint.

GET /v1/terminal/bundle — returns subjects, checkpoints, and presence states
in parallel for terminal bootstrap.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header
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
from models import Alert, Checkpoint, Person, HardwareAsset, Subject, PresenceState

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
    """Place an unregistered barcode in the administrator's alert queue."""
    checkpoint = await db.get(Checkpoint, payload.checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=422, detail="Checkpoint not registered")
    now = datetime.now(timezone.utc)
    alert_id = f"ALERT-{uuid.uuid4().hex[:8].upper()}"
    data = {
        "id": alert_id,
        "severity": "high",
        "status": "open",
        "title": "Unknown barcode requires manual review",
        "reason": "Barcode is not registered; access was denied.",
        "subjectName": "Unregistered barcode",
        "barcode": payload.barcode.strip(),
        "checkpoint": checkpoint.data.get("name", checkpoint.id),
        "date": now.date().isoformat(),
        "time": now.strftime("%H:%M:%S"),
        "category": "operational",
        "createdAt": now.isoformat(),
    }
    db.add(Alert(id=alert_id, created_at=now, data=data))
    await db.commit()
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

    return {
        "subjects":    subjects,
        "checkpoints": checkpoints,
        "presence":    presence,
    }
