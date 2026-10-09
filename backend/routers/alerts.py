"""
Alert & AlertRule endpoints.

GET  /v1/alerts              — list alerts with optional status filter
PATCH /v1/alerts/{id}        — acknowledge an alert (auth-protected)
POST /v1/alerts/evaluate     — placeholder rule evaluation
POST /v1/alerts/{id}/review — accept or excuse an alert (admin)
POST /v1/alert-warnings/{id}/reset — reset warnings and lift a critical hold (admin)
PATCH /v1/alert-rules/{id}   — read-only rule policy (writes rejected)
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_, union_all, case
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, ConfigDict, Field, field_validator

from auth import verify_admin_request
from database import get_db, get_read_db
from models import Alert, AlertRule, AlertReview, Subject
from critical_entry_restrictions import entry_restrictions_for_subjects, release_critical_entry_restriction
from alert_reviews import (
    AlertReviewInput, WarningResetInput, enrich_alert_documents, review_alert, reset_subject_warnings,
)
from alert_rule_assignments import AlertRuleAssignmentInput, list_alert_rule_assignments, replace_alert_rule_assignment
from redis_client import publish_data_changed, publish_presence_update
import json
import logging

logger = logging.getLogger(__name__)

router = APIRouter(tags=["alerts"])


@router.get("/v1/alert-rule-assignments")
async def alert_rule_assignment_directory(
    db: AsyncSession = Depends(get_read_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """List default/custom rule selections for registered employees and hardware."""
    return await list_alert_rule_assignments(db)


@router.put("/v1/alert-rule-assignments/{subject_id}")
async def update_alert_rule_assignment(
    subject_id: str,
    payload: AlertRuleAssignmentInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    assignment, changed = await replace_alert_rule_assignment(db, subject_id, payload.ruleIds,
        admin.get("sub", "unknown"), payload.expectedRevision, payload.irregularitySkipDates)
    await db.commit()
    if changed:
        try:
            await publish_data_changed()
        except Exception:
            logger.exception("Alert rule assignments saved; live publication failed")
    return assignment


class EntryRestrictionRelease(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(strict=True, min_length=1, max_length=1000)

    @field_validator("reason")
    @classmethod
    def reason_is_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("A reason is required to lift the entry restriction")
        return value


# ---------------------------------------------------------------------------
# GET /v1/alerts
# ---------------------------------------------------------------------------

@router.get("/v1/alerts")
async def list_alerts(
    status: Optional[str] = Query(None, pattern="^(active|open|acknowledged|warned|resolved)$"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    subjectId: Optional[str] = Query(None, min_length=1, max_length=200),
    search: Optional[str] = Query(None, max_length=200),
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Return paginated alerts and all alert rules.
    Optional ?status= filters alerts by data->>'status'.
    """
    # -- Alerts query --
    # Retained reviews appear once, including after their source alert is purged.
    archived_status = case(
        (AlertReview.alert_data["warningReset"].astext.is_not(None), "acknowledged"),
        (AlertReview.decision == "confirmed", "warned"), else_="resolved")
    archived_data = AlertReview.alert_data.op("||")(func.jsonb_build_object(
        "id", AlertReview.alert_id, "status", archived_status))
    records = union_all(
        select(Alert.id.label("id"), Alert.created_at.label("created_at"), Alert.data.label("data")),
        select(AlertReview.alert_id, AlertReview.alert_created_at, archived_data)
            .where(~select(Alert.id).where(Alert.id == AlertReview.alert_id).exists()),
    ).subquery("listed_alerts")
    excluded_alert = or_(
        (records.c.data["manualReview"].astext == "true")
        | (records.c.data["ruleId"].astext == "rule-manual-review")
        | (records.c.data["ruleId"].astext == "rule-unknown-barcode")
        | records.c.data["title"].astext.ilike("Unknown barcode%")
        | records.c.data["title"].astext.ilike("Access decision denied")
    )
    alerts_q = select(records).outerjoin(AlertReview, AlertReview.alert_id == records.c.id).where(~func.coalesce(excluded_alert, False))
    count_q = select(func.count()).select_from(records).outerjoin(AlertReview,
        AlertReview.alert_id == records.c.id).where(~func.coalesce(excluded_alert, False))

    if subjectId:
        subject_id = subjectId.strip()
        if not subject_id:
            raise HTTPException(422, "Subject filter must not be blank")
        barcode = await db.scalar(select(Subject.barcode).where(Subject.id == subject_id))
        legacy_identity = func.btrim(records.c.data["subjectId"].astext) == subject_id
        if barcode:
            # Legacy barcode matches apply only when no explicit identity was supplied.
            no_identity = or_(records.c.data["subjectId"].astext.is_(None), records.c.data["subjectId"].astext == "")
            legacy_identity = or_(legacy_identity, no_identity &
                (func.lower(func.btrim(records.c.data["barcode"].astext)) == barcode.lower()))
        subject_filter = or_(AlertReview.subject_id == subject_id,
            AlertReview.alert_id.is_(None) & legacy_identity)
        alerts_q, count_q = alerts_q.where(subject_filter), count_q.where(subject_filter)
    if search and search.strip():
        literal = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = "%" + literal + "%"
        search_filter = or_(*(records.c.data[field].astext.ilike(pattern, escape="\\")
            for field in ("title", "subjectName", "barcode", "reason", "explanation")),
            AlertReview.reason.ilike(pattern, escape="\\"))
        alerts_q, count_q = alerts_q.where(search_filter), count_q.where(search_filter)

    for value, is_start in ((startAt, True), (endAt, False)):
        if not value:
            continue
        try:
            bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(422, "Date filter must be ISO 8601") from error
        condition = records.c.created_at >= bound if is_start else records.c.created_at <= bound
        alerts_q = alerts_q.where(condition)
        count_q = count_q.where(condition)

    if status:
        alert_status = records.c.data["status"].astext
        status_filter = (
            or_(alert_status.in_(("open", "warned")), alert_status.is_(None))
            if status == "active"
            else
            or_(alert_status == "open", alert_status.is_(None))
            if status == "open"
            else alert_status == status
        )
        alerts_q = alerts_q.where(status_filter)
        count_q = count_q.where(status_filter)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()

    alerts_res = await db.execute(alerts_q.order_by(records.c.created_at.desc(), records.c.id).limit(limit).offset(offset))
    alerts = [SimpleNamespace(**row) for row in alerts_res.mappings().all()]
    enriched = await enrich_alert_documents(db, alerts)

    recent_cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    recent_res = await db.execute(
        select(records.c.data).where(records.c.created_at >= recent_cutoff)
    )
    recent_triggers: dict[str, int] = {}
    for data in recent_res.scalars().all():
        rule_id = str((data or {}).get("ruleId") or "")
        if rule_id:
            recent_triggers[rule_id] = recent_triggers.get(rule_id, 0) + 1

    # -- Rules query (all) --
    rules_res = await db.execute(select(AlertRule).order_by(AlertRule.id))
    rules = rules_res.scalars().all()
    if not rules:
        from rule_engine import default_alert_rules
        rule_data = default_alert_rules()
    else:
        from rule_engine import with_default_alert_rules
        rule_data = with_default_alert_rules([r.data for r in rules])
    rule_data = [
        {**rule, "recentTriggers": recent_triggers.get(str(rule.get("id")), 0)}
        for rule in rule_data
    ]

    return {
        "items":  enriched["items"],
        "warnings": enriched["warnings"],
        "rules":  rule_data,
        "total":  total,
        "limit": limit,
        "offset": offset,
    }


# ---------------------------------------------------------------------------
# PATCH /v1/alerts/{id}
# ---------------------------------------------------------------------------

@router.patch("/v1/alerts/{alert_id}")
async def update_alert(
    alert_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Acknowledge an alert while preserving its stored record."""
    if payload != {"status": "acknowledged"}:
        raise HTTPException(status_code=422, detail="Alerts can only be acknowledged")
    result = await db.execute(select(Alert).where(Alert.id == alert_id).with_for_update())
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    if await db.get(AlertReview, alert_id):
        raise HTTPException(409, "Reviewed alerts are final; reset the subject warnings to clear accepted warnings")
    merged = {**(alert.data or {}), **payload, "id": alert.id}
    alert.data = merged
    await db.commit()
    await db.refresh(alert)
    restrictions = await entry_restrictions_for_subjects(db, [(alert.data or {}).get("subjectId")]
        if (alert.data or {}).get("subjectId") else [])
    response = {**alert.data, "entryRestriction": restrictions.get(alert.data.get("subjectId"))}
    try:
        await publish_presence_update(json.dumps({"type": "alert_acknowledged", "alerts": [response]}))
    except Exception:
        logger.exception("Alert acknowledgement saved; live publication failed")
    return response


@router.post("/v1/alerts/{alert_id}/review")
async def submit_alert_review(
    alert_id: str,
    payload: AlertReviewInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    result = await review_alert(db, alert_id, payload.decision, admin.get("sub", "unknown"), payload.reason)
    await db.commit()
    if "auditEvent" in result:
        try:
            await publish_data_changed()
        except Exception:
            logger.exception("Alert review saved; live publication failed")
    return result


@router.post("/v1/alert-warnings/{subject_id}/reset")
async def reset_alert_warnings(
    subject_id: str,
    payload: WarningResetInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    result = await reset_subject_warnings(db, subject_id, admin.get("sub", "unknown"), payload.reason)
    await db.commit()
    if "auditEvent" in result:
        try:
            await publish_data_changed()
        except Exception:
            logger.exception("Warning reset saved; live publication failed")
    return result


@router.post("/v1/alerts/{alert_id}/release-entry-restriction")
async def release_entry_restriction(
    alert_id: str,
    payload: EntryRestrictionRelease,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Lift a critical hold explicitly, without changing normal access or presence."""
    result = await release_critical_entry_restriction(db, alert_id, admin.get("sub", "unknown"), payload.reason)
    await db.commit()
    try:
        await publish_data_changed()
    except Exception:
        logger.exception("Entry restriction release saved; live publication failed")
    return result


# ---------------------------------------------------------------------------
# POST /v1/alerts/evaluate  (placeholder)
# ---------------------------------------------------------------------------

@router.post("/v1/alerts/evaluate")
async def evaluate_alerts(
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Run the same rule evaluation used by the scheduled worker."""
    from workflows.activities import run_alert_rule_evaluation
    triggered = await run_alert_rule_evaluation()
    return {"triggered": triggered, "message": "Alert rules evaluated"}


# ---------------------------------------------------------------------------
# PATCH /v1/alert-rules/{id}
# ---------------------------------------------------------------------------

@router.patch("/v1/alert-rules/{rule_id}")
async def update_alert_rule(
    rule_id: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Global rule definitions are read-only; per-subject assignments are separate."""
    raise HTTPException(403, "Automated rule definitions are read-only; manage per-subject rule assignments instead")
