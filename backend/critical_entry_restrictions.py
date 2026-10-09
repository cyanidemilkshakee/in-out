"""Durable server-owned entry holds. Callers own the surrounding transaction.

Alert acknowledgement and ordinary permission changes never update this table.
The Subject row is the serialization point shared with scans/manual decisions.
"""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.dialects.postgresql import insert

from models import (
    Subject, CriticalEntryRestriction, CriticalAlertTrigger, AuditEvent,
    AlertReview, WarningReset,
)

CONFIRMED_WARNING_ENTRY_THRESHOLD = 3


def restriction_document(row):
    return {
        "subjectId": row.subject_id,
        "active": row.active,
        "triggeredAt": row.triggered_at.isoformat(),
        "triggerAlertId": row.trigger_alert_id,
        "releasedAt": row.released_at.isoformat() if row.released_at else None,
        "releasedBy": row.released_by,
        "releaseReason": row.release_reason,
    }


async def entry_restrictions_for_subjects(db, subject_ids, *, active_only=False):
    """One query for server-owned state, suitable for directories and scan checks."""
    ids = sorted({subject_id for subject_id in subject_ids if isinstance(subject_id, str) and subject_id})
    if not ids:
        return {}
    query = select(CriticalEntryRestriction).where(CriticalEntryRestriction.subject_id.in_(ids))
    if active_only:
        query = query.where(CriticalEntryRestriction.active.is_(True))
    rows = (await db.scalars(query.execution_options(populate_existing=True))).all()
    return {row.subject_id: restriction_document(row) for row in rows}


async def confirmed_warning_count(db, subject_id):
    """Count confirmed warnings in the subject's current reset period."""
    reset = await db.get(WarningReset, subject_id, populate_existing=True)
    query = select(func.count()).select_from(AlertReview).where(
        AlertReview.subject_id == subject_id,
        AlertReview.decision == "confirmed",
    )
    if reset:
        query = query.where(AlertReview.reviewed_at > reset.reset_at)
    return int(await db.scalar(query) or 0)


async def activate_warning_threshold_entry_restriction(db, subject_id, alert_id, triggered_at):
    """Persist an entry hold caused by the third confirmed warning."""
    marker = await db.get(CriticalAlertTrigger, alert_id, populate_existing=True)
    if marker and marker.subject_id not in (None, subject_id):
        raise HTTPException(409, "The warning is bound to a different subject")
    if marker is None:
        db.add(CriticalAlertTrigger(alert_id=alert_id, subject_id=subject_id, triggered_at=triggered_at))
    elif marker.subject_id is None:
        # The authenticated review explicitly binds this warning to a subject.
        marker.subject_id = subject_id

    row = await db.get(CriticalEntryRestriction, subject_id, populate_existing=True)
    if row and row.active:
        return restriction_document(row)
    if row is None:
        row = CriticalEntryRestriction(
            subject_id=subject_id,
            active=True,
            triggered_at=triggered_at,
            trigger_alert_id=alert_id,
        )
        db.add(row)
    else:
        row.active = True
        row.triggered_at = triggered_at
        row.trigger_alert_id = alert_id
        row.released_at = row.released_by = row.release_reason = None

    subject = await db.get(Subject, subject_id)
    audit_id = "AUD-" + uuid.uuid4().hex
    db.add(AuditEvent(id=audit_id, created_at=triggered_at, data={
        "id": audit_id,
        "category": "permission",
        "action": "Three confirmed warnings entry restricted",
        "subjectId": subject_id,
        "barcode": subject.barcode if subject else None,
        "actor": "system",
        "role": "System",
        "decision": "denied",
        "reason": "Three confirmed warnings require administrator release.",
        "relatedId": alert_id,
        "createdAt": triggered_at.isoformat(),
    }))
    await db.flush()
    return restriction_document(row)


async def ensure_legacy_warning_threshold_restrictions(db, subject_ids):
    """Materialize holds for existing subjects already at the warning threshold.

    Call only after locking the supplied Subject rows. Existing inactive holds are
    respected only when they were released after the third confirmed warning.
    """
    ids = sorted({value for value in subject_ids if isinstance(value, str) and value})
    if not ids:
        return {}
    restriction_rows = {row.subject_id: row for row in (await db.scalars(
        select(CriticalEntryRestriction).where(CriticalEntryRestriction.subject_id.in_(ids))
    )).all()}
    candidates = [subject_id for subject_id in ids
        if subject_id not in restriction_rows or not restriction_rows[subject_id].active]
    if not candidates:
        return {subject_id: restriction_document(row) for subject_id, row in restriction_rows.items()}

    resets = {row.subject_id: row for row in (await db.scalars(
        select(WarningReset).where(WarningReset.subject_id.in_(candidates))
    )).all()}
    count_query = select(AlertReview.subject_id, func.count()).outerjoin(
        WarningReset, WarningReset.subject_id == AlertReview.subject_id
    ).where(
        AlertReview.subject_id.in_(candidates),
        AlertReview.decision == "confirmed",
        or_(WarningReset.reset_at.is_(None), AlertReview.reviewed_at > WarningReset.reset_at),
    )
    count_query = count_query.group_by(AlertReview.subject_id)
    counts = dict((await db.execute(count_query)).all())

    for subject_id in candidates:
        if counts.get(subject_id, 0) < CONFIRMED_WARNING_ENTRY_THRESHOLD:
            continue
        warning_query = select(AlertReview).where(
            AlertReview.subject_id == subject_id,
            AlertReview.decision == "confirmed",
        )
        reset = resets.get(subject_id)
        if reset:
            warning_query = warning_query.where(AlertReview.reviewed_at > reset.reset_at)
        threshold_warning = await db.scalar(warning_query.order_by(
            AlertReview.reviewed_at, AlertReview.alert_id
        ).offset(CONFIRMED_WARNING_ENTRY_THRESHOLD - 1).limit(1))
        row = restriction_rows.get(subject_id)
        if row and row.released_at and threshold_warning and row.released_at >= threshold_warning.reviewed_at:
            continue
        latest = await db.scalar(warning_query.order_by(
            AlertReview.reviewed_at.desc(), AlertReview.alert_id.desc()
        ).limit(1))
        if latest:
            await activate_warning_threshold_entry_restriction(
                db, subject_id, latest.alert_id, datetime.now(timezone.utc)
            )
    return await entry_restrictions_for_subjects(db, ids)


def _binding(data):
    subject_id = data.get("subjectId")
    if isinstance(subject_id, str) and subject_id.strip():
        return "id", subject_id.strip()
    # A supplied, invalid ID must never silently bind by a reused barcode.
    if subject_id is not None and subject_id != "":
        return None
    barcode = data.get("barcode")
    if isinstance(barcode, str) and barcode.strip():
        return "barcode", barcode.strip().lower()
    return None


async def activate_critical_entry_restrictions(db, alerts):
    """Bind new critical alerts to explicit IDs/barcodes and atomically hold entry.

    Distinct alerts can retrigger a released hold. Reprocessing an old alert,
    including an acknowledged one, cannot. Unbound alerts are recorded once;
    later registration/reuse of their barcode must not restrict a new person.
    """
    critical = [alert for alert in alerts if (alert.data or {}).get("severity") == "critical"]
    if not critical:
        return {}
    processed = set((await db.scalars(select(CriticalAlertTrigger.alert_id).where(
        CriticalAlertTrigger.alert_id.in_([alert.id for alert in critical])
    ))).all())
    pending = [alert for alert in critical if alert.id not in processed]
    if not pending:
        return {}
    bindings = {alert.id: _binding(alert.data or {}) for alert in pending}
    ids = [binding[1] for binding in bindings.values() if binding and binding[0] == "id"]
    barcodes = [binding[1] for binding in bindings.values() if binding and binding[0] == "barcode"]
    predicates = []
    if ids:
        predicates.append(Subject.id.in_(ids))
    if barcodes:
        predicates.append(func.lower(Subject.barcode).in_(barcodes))
    subjects = list((await db.scalars(select(Subject).where(or_(*predicates))
        .order_by(Subject.id).with_for_update())).all()) if predicates else []
    by_id = {subject.id: subject for subject in subjects}
    by_barcode = {}
    for subject in subjects:
        by_barcode.setdefault(subject.barcode.lower(), []).append(subject)
    now = datetime.now(timezone.utc)
    affected = set()
    for alert in sorted(pending, key=lambda item: (item.created_at, item.id)):
        binding = bindings[alert.id]
        subject = None
        if binding:
            kind, value = binding
            if kind == "id":
                subject = by_id.get(value)
            else:
                matches = by_barcode.get(value, [])
                subject = matches[0] if len(matches) == 1 else None
        inserted = await db.scalar(insert(CriticalAlertTrigger).values(
            alert_id=alert.id, subject_id=subject.id if subject else None,
            triggered_at=alert.created_at,
        ).on_conflict_do_nothing(index_elements=["alert_id"]).returning(CriticalAlertTrigger.alert_id))
        if not inserted or not subject:
            continue
        # Pin legacy barcode binding to this identity for all later responses.
        alert.data = {**(alert.data or {}), "subjectId": subject.id}
        row = await db.get(CriticalEntryRestriction, subject.id, populate_existing=True)
        # A delayed import of an alert predating release must not undo release.
        if row and row.released_at and alert.created_at <= row.released_at:
            continue
        if row and (alert.created_at, alert.id) < (row.triggered_at, row.trigger_alert_id):
            continue
        if row is None:
            row = CriticalEntryRestriction(subject_id=subject.id, active=True,
                triggered_at=alert.created_at, trigger_alert_id=alert.id)
            db.add(row)
        else:
            row.active = True
            row.triggered_at = alert.created_at
            row.trigger_alert_id = alert.id
            row.released_at = row.released_by = row.release_reason = None
        audit_id = "AUD-" + uuid.uuid4().hex
        db.add(AuditEvent(id=audit_id, created_at=now, data={
            "id": audit_id, "category": "permission", "action": "Critical alert entry restricted",
            "subjectId": subject.id, "barcode": subject.barcode, "actor": "system", "role": "System",
            "decision": "denied", "reason": "Critical alert requires explicit administrator release.",
            "relatedId": alert.id, "createdAt": now.isoformat(),
        }))
        affected.add(subject.id)
    await db.flush()
    return await entry_restrictions_for_subjects(db, affected)


async def release_critical_entry_restriction(db, alert_id, actor, reason):
    """Explicit administrative release, guarded against a stale alert card."""
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
        raise HTTPException(422, "A reason of 1 to 1000 characters is required to lift the entry restriction")
    reason = reason.strip()
    marker = await db.get(CriticalAlertTrigger, alert_id)
    if not marker:
        raise HTTPException(404, "Entry restriction not found")
    if not marker.subject_id:
        raise HTTPException(422, "This alert has no registered subject entry restriction")
    subject = await db.scalar(select(Subject).where(Subject.id == marker.subject_id).with_for_update())
    if not subject:
        raise HTTPException(404, "Restricted subject no longer exists")
    row = await db.get(CriticalEntryRestriction, subject.id, populate_existing=True)
    if not row:
        raise HTTPException(404, "Entry restriction not found")
    if row.trigger_alert_id != alert_id:
        raise HTTPException(409, "A newer alert or warning controls this restriction; refresh before releasing")
    if not row.active:
        return {"entryRestriction": restriction_document(row)}
    now = datetime.now(timezone.utc)
    row.active = False
    row.released_at, row.released_by, row.release_reason = now, actor, reason
    audit_id = "AUD-" + uuid.uuid4().hex
    audit = {
        "id": audit_id, "category": "permission", "action": "Entry restriction lifted",
        "subjectId": subject.id, "barcode": subject.barcode, "actor": actor, "role": "Administrator",
        "decision": "granted", "reason": reason, "relatedId": alert_id, "createdAt": now.isoformat(),
    }
    db.add(AuditEvent(id=audit_id, created_at=now, data=audit))
    await db.flush()
    return {"entryRestriction": restriction_document(row), "auditEvent": audit}
