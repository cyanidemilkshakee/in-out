"""Hold unreceipted offline scans for audited presence reconciliation."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from models import AuditEvent, OfflineScanReconciliation, Person, PresenceState, Subject


async def stage_offline_scan(db, *, payload, terminal_id, checkpoint_id, request_data):
    """Persist evidence without creating a movement or changing presence."""
    barcode = payload.barcode.strip()
    subject = await db.scalar(select(Subject).where(
        func.lower(Subject.barcode) == barcode.lower()).limit(1))
    captured_at = payload.captured_offline_at or payload.queue_captured_at
    row = OfflineScanReconciliation(
        id="OFFLINE-" + uuid.uuid4().hex,
        subject_id=subject.id if subject else None,
        subject_identity_at_capture=subject.id if subject else None,
        checkpoint_id=checkpoint_id,
        terminal_id=terminal_id,
        barcode=barcode,
        captured_at=captured_at,
        # Automatic checkpoint scans have no reliable direction once the
        # original receipt is missing. Keep that uncertainty visible so the
        # administrator chooses the corrected presence state explicitly.
        direction=payload.direction or "unknown",
        payload=request_data,
        status="pending",
    )
    db.add(row)
    return row


async def resolve_offline_scan(db, reconciliation_id, *, actor, state, reason):
    """Correct only current presence; movement history remains immutable."""
    if state not in {"inside", "outside", "dismissed"}:
        raise HTTPException(422, "Choose inside, outside, or dismiss this scan")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
        raise HTTPException(422, "A reconciliation reason of 1 to 1000 characters is required")
    row = await db.scalar(select(OfflineScanReconciliation).where(
        OfflineScanReconciliation.id == reconciliation_id).with_for_update())
    if row is None:
        raise HTTPException(404, "Offline scan reconciliation not found")
    if row.status != "pending":
        raise HTTPException(409, "This offline scan has already been reconciled")
    if row.subject_id is None and row.subject_identity_at_capture and state != "dismissed":
        raise HTTPException(409, "The original subject was removed; dismiss this scan instead of reassigning it")
    if row.subject_id is None and state != "dismissed":
        row.subject_id = await db.scalar(select(Subject.id).where(
            func.lower(Subject.barcode) == row.barcode.lower()).limit(1))
        row.subject_identity_at_capture = row.subject_id
    if row.subject_id is None and state != "dismissed":
        raise HTTPException(422, "Register this barcode before correcting its presence")
    subject = await db.scalar(select(Subject).where(Subject.id == row.subject_id)
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
        .with_for_update().execution_options(populate_existing=True)) if row.subject_id else None
    if row.subject_id and (subject is None or subject.barcode.lower() != row.barcode.lower()
            or (row.subject_identity_at_capture and subject.id != row.subject_identity_at_capture)):
        raise HTTPException(409, "The barcode identity changed; review the registry before reconciling")
    from models import Checkpoint
    checkpoint = await db.get(Checkpoint, row.checkpoint_id)
    if checkpoint is None:
        raise HTTPException(409, "The original checkpoint is no longer available")
    now = datetime.now(timezone.utc)
    if state == "dismissed":
        row.status = "dismissed"
        row.resolution_reason = reason.strip()
        row.resolved_by = actor
        row.resolved_at = now
        audit_id = "AUD-" + uuid.uuid4().hex
        audit = {"id": audit_id, "category": "presence", "action": "Offline scan dismissed",
            "actor": actor, "role": "Administrator", "reason": reason.strip(),
            "subjectId": row.subject_id, "barcode": row.barcode, "offlineScanId": row.id,
            "checkpointId": checkpoint.id, "correctedState": None,
            "createdAt": now.isoformat(), "movementHistoryChanged": False}
        db.add(AuditEvent(id=audit_id, created_at=now, data=audit))
        await db.flush()
        return {"id": row.id, "status": row.status, "state": None, "subjectId": row.subject_id,
            "barcode": row.barcode, "checkpointId": checkpoint.id, "resolvedAt": now.isoformat(),
            "auditEvent": audit}
    presence = await db.scalar(select(PresenceState).where(
        PresenceState.subject_id == subject.id).with_for_update())
    if presence is None:
        presence = PresenceState(subject_id=subject.id, state="outside")
        db.add(presence)
        await db.flush()
    presence.state = state
    presence.last_scan_timestamp = now
    presence.entry_building_id = checkpoint.zone_id if state == "inside" else None
    presence.entry_started_at = now if state == "inside" else None
    presence.no_break_alerted_interval = 0
    presence.visitor_permission_overstay_alerted_valid_to = None
    presence.entry_override = None
    metadata = subject.hardware if subject.kind == "hardware" else subject.person
    if metadata is not None:
        metadata.data = {**(metadata.data or {}), "inside": state == "inside"}
    row.status = "resolved"
    row.resolution_state = state
    row.resolution_reason = reason.strip()
    row.resolved_by = actor
    row.resolved_at = now
    audit_id = "AUD-" + uuid.uuid4().hex
    audit = {"id": audit_id, "category": "presence", "action": "Offline scan presence reconciled",
        "actor": actor, "role": "Administrator", "reason": reason.strip(),
        "subjectId": subject.id, "barcode": subject.barcode, "offlineScanId": row.id,
        "checkpointId": checkpoint.id, "previousCapturedAt": row.captured_at.isoformat() if row.captured_at else None,
        "correctedState": state, "createdAt": now.isoformat(),
        "movementHistoryChanged": False}
    db.add(AuditEvent(id=audit_id, created_at=now, data=audit))
    await db.flush()
    document = {**(metadata.data if metadata is not None else {}), "id": subject.id,
        "barcode": subject.barcode, "type": subject.kind, "inside": state == "inside"}
    return {"id": row.id, "status": row.status, "state": state, "subjectId": subject.id,
        "barcode": subject.barcode, "checkpointId": checkpoint.id, "resolvedAt": now.isoformat(),
        "subjectRecord": document, "auditEvent": audit}
