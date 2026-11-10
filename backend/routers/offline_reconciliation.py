"""Administrator review of offline scans without their original receipt."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_db
from event_outbox import enqueue_presence
from models import Checkpoint, OfflineScanReconciliation
from offline_reconciliation import resolve_offline_scan
from zone_access import admin_zone_ids

router = APIRouter(tags=["offline scan reconciliation"])


class ReconciliationDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["inside", "outside", "dismissed"]
    reason: str = Field(min_length=1, max_length=1000)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("A reconciliation reason is required")
        return value


@router.get("/v1/offline-scan-reconciliations")
async def list_offline_scan_reconciliations(
    status: Literal["pending", "resolved", "dismissed"] = "pending",
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
):
    zones = await admin_zone_ids(db, admin)
    rows = (await db.execute(select(OfflineScanReconciliation, Checkpoint)
        .join(Checkpoint, Checkpoint.id == OfflineScanReconciliation.checkpoint_id)
        .where(Checkpoint.zone_id.in_(zones), OfflineScanReconciliation.status == status)
        .order_by(OfflineScanReconciliation.received_at.desc(), OfflineScanReconciliation.id)
        .limit(limit))).all()
    return {"items": [{"id": row.id, "subjectId": row.subject_id, "barcode": row.barcode,
        "terminalId": row.terminal_id, "checkpointId": checkpoint.id,
        "checkpoint": (checkpoint.data or {}).get("name", checkpoint.id), "zoneId": checkpoint.zone_id,
        "direction": row.direction, "capturedAt": row.captured_at.isoformat() if row.captured_at else None,
        "receivedAt": row.received_at.isoformat(), "status": row.status}
        for row, checkpoint in rows]}


@router.post("/v1/offline-scan-reconciliations/{reconciliation_id}/resolve")
async def resolve_offline_scan_reconciliation(
    reconciliation_id: str,
    payload: ReconciliationDecision,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
):
    row = await db.get(OfflineScanReconciliation, reconciliation_id)
    if row is None:
        raise HTTPException(404, "Offline scan reconciliation not found")
    checkpoint = await db.get(Checkpoint, row.checkpoint_id)
    if checkpoint is None or checkpoint.zone_id not in await admin_zone_ids(db, admin):
        raise HTTPException(403, "This scan is outside your assigned zones")
    result = await resolve_offline_scan(db, reconciliation_id, actor=admin.get("sub", "unknown"),
        state=payload.state, reason=payload.reason)
    document = result.pop("subjectRecord", None)
    if document is not None:
        subject_id = result["subjectId"]
        is_hardware = document.get("type") == "hardware"
        await enqueue_presence(db, {"type": "presence_reconciled", "subject_id": subject_id,
            "state": payload.state,
            "people": [document] if not is_hardware else [],
            "hardwareAssets": [document] if is_hardware else []})
    await db.commit()
    return result
