"""Final alert reviews and warning resets; callers commit the whole transaction.

Subject locks serialize reviews, resets, critical activation, and terminal scans.
Alert decisions are immutable and survive retention of the original alert row.
"""
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select, func, or_
from sqlalchemy.orm import selectinload

from models import Alert, AlertReview, WarningReset, Subject, AuditEvent, CriticalEntryRestriction
from critical_entry_restrictions import (
    entry_restrictions_for_subjects, release_critical_entry_restriction,
    CONFIRMED_WARNING_ENTRY_THRESHOLD, confirmed_warning_count,
    activate_warning_threshold_entry_restriction,
)


class AlertReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["confirmed", "excused"]
    reason: Optional[str] = Field(default=None, strict=True, max_length=1000)

    @field_validator("reason")
    @classmethod
    def trim_reason(cls, value):
        return value.strip() if value is not None else value

    @model_validator(mode="after")
    def excuse_requires_reason(self):
        if self.decision == "excused" and not self.reason:
            raise ValueError("A reason is required to excuse an alert")
        return self


class WarningResetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(strict=True, min_length=1, max_length=1000)

    @field_validator("reason")
    @classmethod
    def reason_is_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("A reason is required to reset warnings")
        return value


def review_document(row):
    return {"decision": row.decision, "reason": row.reason,
        "reviewedAt": row.reviewed_at.isoformat(), "reviewedBy": row.reviewed_by}


def _binding(data):
    subject_id = data.get("subjectId")
    if isinstance(subject_id, str) and subject_id.strip():
        return "id", subject_id.strip()
    # Never use a name or fall back from an explicitly invalid identity.
    if subject_id is not None and subject_id != "":
        return None
    barcode = data.get("barcode")
    if isinstance(barcode, str) and barcode.strip():
        return "barcode", barcode.strip().lower()
    return None


async def _resolve_subject(db, binding):
    if not binding:
        return None
    kind, value = binding
    predicate = Subject.id == value if kind == "id" else func.lower(Subject.barcode) == value
    matches = (await db.scalars(select(Subject).where(predicate))).all()
    return matches[0] if len(matches) == 1 else None


def _resolve_from_directory(data, by_id, by_barcode):
    binding = _binding(data)
    if not binding:
        return None
    kind, value = binding
    if kind == "id":
        return by_id.get(value)
    matches = by_barcode.get(value, [])
    return matches[0] if len(matches) == 1 else None


async def warning_directory(db):
    """Bulk, authoritative warning counts independent of alert pagination/retention."""
    subjects = (await db.scalars(select(Subject).options(
        selectinload(Subject.person), selectinload(Subject.hardware)).order_by(Subject.id))).all()
    resets = {row.subject_id: row for row in (await db.scalars(select(WarningReset))).all()}
    counts = dict((await db.execute(select(AlertReview.subject_id, func.count())
        .outerjoin(WarningReset, WarningReset.subject_id == AlertReview.subject_id)
        .where(AlertReview.decision == "confirmed", or_(WarningReset.reset_at.is_(None),
            AlertReview.reviewed_at > WarningReset.reset_at))
        .group_by(AlertReview.subject_id))).all())
    restrictions = await entry_restrictions_for_subjects(db, [subject.id for subject in subjects])
    by_id = {subject.id: subject for subject in subjects}
    by_barcode = {}
    summaries = {}
    for subject in subjects:
        by_barcode.setdefault(subject.barcode.lower(), []).append(subject)
        metadata = subject.person.data if subject.person else subject.hardware.data if subject.hardware else {}
        reset = resets.get(subject.id)
        summary = {"subjectId": subject.id, "subjectName": metadata.get("name") or subject.barcode,
            "subjectType": subject.kind, "barcode": subject.barcode,
            "count": counts.get(subject.id, 0), "entryRestriction": restrictions.get(subject.id)}
        if reset:
            summary.update(resetAt=reset.reset_at.isoformat(), resetBy=reset.reset_by, resetReason=reset.reason)
        summaries[subject.id] = summary
    return subjects, by_id, by_barcode, summaries, resets


async def enrich_alert_documents(db, alerts):
    """Return alert items and all employee/hardware warning summaries in bulk."""
    _, by_id, by_barcode, summaries, resets = await warning_directory(db)
    ids = [alert.id for alert in alerts]
    reviews = {row.alert_id: row for row in (await db.scalars(
        select(AlertReview).where(AlertReview.alert_id.in_(ids)))).all()} if ids else {}
    items = []
    for alert in alerts:
        review = reviews.get(alert.id)
        data = {**(alert.data or {}), "id": alert.id}
        data.setdefault("createdAt", alert.created_at.isoformat())
        subject = by_id.get(review.subject_id) if review else _resolve_from_directory(data, by_id, by_barcode)
        # Do not expose an invalid legacy ID as a reliably bound subject.
        data.pop("subjectId", None)
        for field in ("warningResetAt", "warningResetBy", "warningResetReason", "warningReset"):
            data.pop(field, None)
        data["entryRestriction"] = None
        data["warningCount"] = 0
        if subject:
            summary = summaries[subject.id]
            data.update(subjectId=subject.id, subjectName=summary["subjectName"],
                subjectType=subject.kind, barcode=subject.barcode,
                warningCount=summary["count"], entryRestriction=summary["entryRestriction"])
            reset = resets.get(subject.id)
            if reset and review and review.decision == "confirmed" and review.reviewed_at <= reset.reset_at:
                reset_data = review.alert_data.get("warningReset") or {
                    "resetAt": reset.reset_at.isoformat(), "resetBy": reset.reset_by, "reason": reset.reason}
                data.update(warningReset=reset_data, warningResetAt=reset_data["resetAt"],
                    warningResetBy=reset_data["resetBy"], warningResetReason=reset_data["reason"])
        if review:
            data["review"] = review_document(review)
        else:
            # These fields are server-owned, not proof of a ledger decision.
            data.pop("review", None)
        items.append(data)
    warnings = [summary for summary in summaries.values() if summary["subjectType"] in ("employee", "hardware")]
    return {"items": items, "warnings": warnings}


def _audit(actor, action, reason, *, subject=None, related_id=None, extra=None):
    now = datetime.now(timezone.utc)
    audit_id = "AUD-" + uuid.uuid4().hex
    data = {"id": audit_id, "category": "alert", "action": action, "actor": actor,
        "role": "Administrator", "reason": reason, "createdAt": now.isoformat(), **(extra or {})}
    if subject:
        data.update(subjectId=subject.id, barcode=subject.barcode)
    if related_id:
        data["relatedId"] = related_id
    return AuditEvent(id=audit_id, created_at=now, data=data)


async def _review_response(db, alert, review):
    # A retained snapshot provides idempotent responses after alert retention.
    if alert is None:
        alert = Alert(id=review.alert_id, created_at=review.alert_created_at,
            data={**review.alert_data, "status": "acknowledged" if review.alert_data.get("warningReset")
                else "warned" if review.decision == "confirmed" else "resolved"})
    enriched = await enrich_alert_documents(db, [alert])
    warning = next((item for item in enriched["warnings"] if item["subjectId"] == review.subject_id), None)
    return {"alert": enriched["items"][0], "warning": warning}


async def review_alert(db, alert_id, decision, actor, reason=None):
    """Subject -> Alert lock order and immutable, idempotent final decisions."""
    if decision not in ("confirmed", "excused") or not isinstance(decision, str):
        raise HTTPException(422, "Alert decision must be confirmed or excused")
    if reason is not None and (not isinstance(reason, str) or len(reason) > 1000):
        raise HTTPException(422, "Alert reason must be text of at most 1000 characters")
    reason = (reason or "").strip()
    if decision == "excused" and not reason:
        raise HTTPException(422, "A reason is required to excuse an alert")
    existing = await db.get(AlertReview, alert_id)
    alert = await db.get(Alert, alert_id)
    if not alert and not existing:
        raise HTTPException(404, "Alert not found")
    binding = ("id", existing.subject_id) if existing and existing.subject_id else _binding(alert.data or {}) if alert else None
    subject = await _resolve_subject(db, binding)
    if subject:
        subject = await db.scalar(select(Subject).where(Subject.id == subject.id).with_for_update()
            .execution_options(populate_existing=True))
        if subject and binding[0] == "barcode" and subject.barcode.lower() != binding[1]:
            raise HTTPException(409, "The alert subject changed; refresh before reviewing")
    alert = await db.scalar(select(Alert).where(Alert.id == alert_id).with_for_update()
        .execution_options(populate_existing=True))
    existing = await db.get(AlertReview, alert_id, populate_existing=True)
    if existing:
        if existing.decision != decision:
            raise HTTPException(409, "This alert already has a final review decision")
        return await _review_response(db, alert, existing)
    if not alert:
        raise HTTPException(404, "Alert not found")
    if _binding(alert.data or {}) != binding:
        raise HTTPException(409, "The alert subject changed; refresh before reviewing")
    if decision == "confirmed" and not subject:
        raise HTTPException(422, "A registered subject is required to confirm a warning")
    # Read time after the serialization lock, not the transaction start time.
    now = datetime.now(timezone.utc)
    snapshot = {**(alert.data or {}), "id": alert.id}
    snapshot["createdAt"] = alert.created_at.isoformat()
    if subject:
        snapshot.update(subjectId=subject.id, barcode=subject.barcode)
    review = AlertReview(alert_id=alert_id, subject_id=subject.id if subject else None,
        decision=decision, reason=reason, reviewed_at=now, reviewed_by=actor,
        alert_created_at=alert.created_at, alert_data=snapshot)
    db.add(review)
    alert.data = {**snapshot, "status": "warned" if decision == "confirmed" else "resolved",
        "review": review_document(review)}
    audit = _audit(actor, "Alert accepted as warning" if decision == "confirmed" else "Alert excused",
        reason, subject=subject, related_id=alert_id, extra={"alertDecision": decision})
    db.add(audit)
    await db.flush()
    if decision == "confirmed" and subject:
        warning_count = await confirmed_warning_count(db, subject.id)
        if warning_count >= CONFIRMED_WARNING_ENTRY_THRESHOLD:
            await activate_warning_threshold_entry_restriction(db, subject.id, alert.id, now)
    response = await _review_response(db, alert, review)
    response["auditEvent"] = audit.data
    return response


async def reset_subject_warnings(db, subject_id, actor, reason):
    """Reset counts and release the current entry hold in one transaction."""
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
        raise HTTPException(422, "A reason of 1 to 1000 characters is required to reset warnings")
    reason = reason.strip()
    subject = await db.scalar(select(Subject).where(Subject.id == subject_id).with_for_update())
    if not subject:
        raise HTTPException(404, "Registered subject not found")
    reset = await db.get(WarningReset, subject_id, populate_existing=True)
    query = select(AlertReview).where(AlertReview.subject_id == subject_id, AlertReview.decision == "confirmed")
    if reset:
        query = query.where(AlertReview.reviewed_at > reset.reset_at)
    current_reviews = (await db.scalars(query)).all()
    restriction = await db.get(CriticalEntryRestriction, subject_id, populate_existing=True)
    active_hold = restriction is not None and restriction.active
    if reset and not current_reviews and not active_hold:
        _, _, _, summaries, _ = await warning_directory(db)
        return {"warning": summaries[subject_id], "entryRestriction": summaries[subject_id]["entryRestriction"]}
    now = datetime.now(timezone.utc)
    if reset is None:
        reset = WarningReset(subject_id=subject_id, reset_at=now, reset_by=actor, reason=reason)
        db.add(reset)
    else:
        reset.reset_at, reset.reset_by, reset.reason = now, actor, reason
    # Keep original review/history, but reset accepted alerts leave active views.
    ids = [review.alert_id for review in current_reviews]
    reset_document = {"resetAt": now.isoformat(), "resetBy": actor, "reason": reason}
    for review in current_reviews:
        review.alert_data = {**review.alert_data, "status": "acknowledged", "warningReset": reset_document}
    if ids:
        alerts = (await db.scalars(select(Alert).where(Alert.id.in_(ids)).order_by(Alert.id).with_for_update())).all()
        for alert in alerts:
            if (alert.data or {}).get("status") == "warned":
                alert.data = {**alert.data, "status": "acknowledged", "warningReset": reset_document}
    release = await release_critical_entry_restriction(db, restriction.trigger_alert_id, actor, reason) if active_hold else None
    audit = _audit(actor, "Subject warnings reset", reason, subject=subject,
        extra={"previousWarningCount": len(current_reviews), "entryRestrictionLifted": active_hold})
    db.add(audit)
    await db.flush()
    _, _, _, summaries, _ = await warning_directory(db)
    response = {"warning": summaries[subject_id], "entryRestriction": summaries[subject_id]["entryRestriction"],
        "auditEvent": audit.data}
    if release and "auditEvent" in release:
        response["releaseAuditEvent"] = release["auditEvent"]
    return response
