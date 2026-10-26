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
from sqlalchemy import select, func, or_, union_all, case, and_
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, ConfigDict, Field, field_validator

from auth import verify_admin_request
from database import get_db, get_read_db
from data_limits import bounded_rows
from event_outbox import enqueue_changed, enqueue_presence
from models import AccessPermission, Alert, AlertReview, Checkpoint, HardwareAsset, Person, Subject
from critical_entry_restrictions import release_critical_entry_restriction
from alert_reviews import (
    AlertReviewInput, WarningResetInput, acknowledge_alert, enrich_alert_documents, review_alert, reset_subject_warnings,
)
from alert_rule_assignments import (
    AlertRuleAssignmentInput, alert_rule_catalog, list_alert_rule_assignments, replace_alert_rule_assignment,
)
from alert_queries import command_center_assignments, confirmed_people_warning_total, focused_alert_people, current_subject_warning_documents
from redis_client import publish_data_changed, publish_presence_update
from zone_access import admin_zone_ids, require_alert_scope, require_subject_scope, subject_zone_condition
import json
import logging

logger = logging.getLogger(__name__)

router = APIRouter(tags=["alerts"])


def _parse_alert_bound(value: str) -> datetime:
    try:
        bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(422, "Date filter must be ISO 8601") from error
    return bound.replace(tzinfo=timezone.utc) if bound.tzinfo is None else bound


def _alert_status_filter(status_column, status: str):
    if status == "active":
        return or_(status_column.in_(("open", "warned")), status_column.is_(None))
    if status == "open":
        return or_(status_column == "open", status_column.is_(None))
    return status_column == status


@router.get("/v1/alert-rule-assignments")
async def alert_rule_assignment_directory(
    subjectId: Optional[str] = Query(None, min_length=1, max_length=200),
    db: AsyncSession = Depends(get_read_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """List default/custom rule selections for registered employees and hardware."""
    zone_ids = await admin_zone_ids(db, _admin)
    visible_ids = list((await db.scalars(select(Subject.id)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids)).distinct().order_by(Subject.id))).all())
    if subjectId:
        await require_subject_scope(db, _admin, subjectId)
    return await list_alert_rule_assignments(db, subjectId, subject_ids=visible_ids)


@router.put("/v1/alert-rule-assignments/{subject_id}")
async def update_alert_rule_assignment(
    subject_id: str,
    payload: AlertRuleAssignmentInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    await require_subject_scope(db, admin, subject_id)
    assignment, changed = await replace_alert_rule_assignment(db, subject_id, payload.ruleIds,
        admin.get("sub", "unknown"), payload.expectedRevision, payload.irregularitySkipDates)
    if changed:
        await enqueue_changed(db)
    await db.commit()
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
    sortKey: str = Query("createdAt", pattern="^(createdAt|title|subjectName|subjectType|severity|status)$"),
    sortDirection: str = Query("desc", pattern="^(asc|desc)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    subjectId: Optional[str] = Query(None, min_length=1, max_length=200),
    search: Optional[str] = Query(None, max_length=200),
    view: Optional[str] = Query(None, pattern="^(command|subject|count)$"),
    reviewState: Optional[str] = Query(None, pattern="^(needs_review|reviewed)$"),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Return paginated alerts and all alert rules.
    Optional ?status= filters alerts by data->>'status'.
    """
    if view == "subject" and (not subjectId or not subjectId.strip()):
        raise HTTPException(422, "A registered subject is required for this view")
    from event_outbox import read_event_revision
    event_revision = await read_event_revision(db)
    zone_ids = await admin_zone_ids(db, actor)
    visible_subject_ids = list((await db.scalars(select(Subject.id)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids)).distinct().order_by(Subject.id))).all())
    # -- Alerts query --
    # Retained reviews appear once, including after their source alert is purged.
    archived_status = case(
        (AlertReview.alert_data["warningReset"].astext.is_not(None), "acknowledged"),
        (AlertReview.decision == "confirmed", "warned"), else_="resolved")
    archived_data = AlertReview.alert_data.op("||")(func.jsonb_build_object(
        "id", AlertReview.alert_id, "status", archived_status,
        "subjectId", func.coalesce(AlertReview.subject_id, AlertReview.alert_data["subjectId"].astext)))
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
    branch_filter = or_(
        records.c.data["zoneId"].astext.in_(zone_ids),
        records.c.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
        records.c.data["subjectId"].astext.in_(visible_subject_ids),
    )
    alerts_q = select(records).outerjoin(AlertReview, AlertReview.alert_id == records.c.id).where(
        ~func.coalesce(excluded_alert, False), branch_filter)
    count_q = select(func.count()).select_from(records).outerjoin(AlertReview,
        AlertReview.alert_id == records.c.id).where(~func.coalesce(excluded_alert, False), branch_filter)

    if view == "command" or reviewState == "needs_review":
        # Acknowledgement does not create a final review. Keep those unreviewed
        # records actionable while excluding every immutable ledger decision.
        unreviewed = AlertReview.alert_id.is_(None) & or_(
            records.c.data["status"].astext.in_(("open", "acknowledged")),
            records.c.data["status"].astext.is_(None))
        alerts_q, count_q = alerts_q.where(unreviewed), count_q.where(unreviewed)
    elif reviewState == "reviewed":
        reviewed = or_(AlertReview.alert_id.is_not(None), records.c.data["status"].astext.in_(("warned", "resolved")))
        alerts_q, count_q = alerts_q.where(reviewed), count_q.where(reviewed)

    if subjectId:
        subject_id = subjectId.strip()
        if not subject_id:
            raise HTTPException(422, "Subject filter must not be blank")
        if subject_id not in visible_subject_ids:
            raise HTTPException(404, "Subject not found")
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
    subject_history = None
    if view == "subject":
        subject_history = (select(records).outerjoin(AlertReview, AlertReview.alert_id == records.c.id)
            .where(~func.coalesce(excluded_alert, False), subject_filter))
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
        bound = _parse_alert_bound(value)
        condition = records.c.created_at >= bound if is_start else records.c.created_at <= bound
        alerts_q = alerts_q.where(condition)
        count_q = count_q.where(condition)

    if status:
        status_filter = _alert_status_filter(records.c.data["status"].astext, status)
        alerts_q = alerts_q.where(status_filter)
        count_q = count_q.where(status_filter)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()
    if view == "count":
        return {"total": total, "eventRevision": event_revision}

    sort_columns = {
        "createdAt": records.c.created_at,
        "title": func.lower(func.coalesce(records.c.data["title"].astext, "")),
        "subjectName": func.lower(func.coalesce(records.c.data["subjectName"].astext, "")),
        "subjectType": func.lower(func.coalesce(records.c.data["subjectType"].astext, "")),
        "severity": case(
            (records.c.data["severity"].astext == "critical", 3),
            (records.c.data["severity"].astext == "high", 2),
            else_=1,
        ),
        "status": func.lower(func.coalesce(records.c.data["status"].astext, "")),
    }
    sort_column = sort_columns[sortKey]
    ordered = sort_column.asc() if sortDirection == "asc" else sort_column.desc()
    alerts_res = await db.execute(alerts_q.order_by(ordered, records.c.id.asc()).limit(limit).offset(offset))
    alerts = [SimpleNamespace(**row) for row in alerts_res.mappings().all()]
    recent_alerts = []
    if subject_history is not None:
        recent_res = await db.execute(subject_history.order_by(records.c.created_at.desc(), records.c.id.asc()).limit(5))
        recent_alerts = [SimpleNamespace(**row) for row in recent_res.mappings().all()]
    enriched = await enrich_alert_documents(db, alerts + recent_alerts, focused=True,
        subject_ids=[subjectId.strip()] if view == "subject" else visible_subject_ids)

    # Share the evaluator's canonical row identities and global rule catalog.
    # Retained serialized IDs must not redirect a rule's displayed trigger count.
    rule_data = await alert_rule_catalog(db)
    recent_cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    rule_id_column = records.c.data["ruleId"].astext
    # Count triggers in SQL rather than loading every recent JSON document.
    # Only catalog IDs can appear in the response, bounding grouped rows even
    # when retained alert history contains many retired or invalid rules.
    recent_rows = await bounded_rows(db, select(rule_id_column, func.count())
        .where(records.c.created_at >= recent_cutoff, branch_filter,
               rule_id_column.in_([rule["id"] for rule in rule_data]))
        .group_by(rule_id_column))
    recent_triggers = {rule_id: int(count) for rule_id, count in recent_rows}
    rule_data = [
        {**rule, "recentTriggers": recent_triggers.get(str(rule.get("id")), 0)}
        for rule in rule_data
    ]

    result = {
        "items":  enriched["items"][:len(alerts)],
        "warnings": enriched["warnings"],
        "rules":  rule_data,
        "total":  total,
        "limit": limit,
        "offset": offset,
        "eventRevision": event_revision,
    }
    if view:
        page_subject_ids = [warning["subjectId"] for warning in enriched["warnings"]]
        result["people"] = await focused_alert_people(db, page_subject_ids)
        result["assignments"] = await command_center_assignments(db, rule_data,
            subject_id=subjectId.strip() if view == "subject" else None,
            subject_ids=visible_subject_ids if view == "command" else None)
        if view == "command":
            result["summary"] = {"openCount": total,
                "confirmedWarnings": await confirmed_people_warning_total(db, visible_subject_ids)}
        else:
            selected_id = subjectId.strip()
            result["totalSubjectAlerts"] = int(await db.scalar(select(func.count()).select_from(subject_history.subquery())) or 0)
            result["recentAlerts"] = enriched["items"][len(alerts):]
            summary = next((warning for warning in enriched["warnings"] if warning["subjectId"] == selected_id), None)
            result["currentWarnings"] = await current_subject_warning_documents(db, selected_id, summary)
    return result


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
    await require_alert_scope(db, _admin, alert_id)
    response = await acknowledge_alert(db, alert_id)
    await enqueue_presence(db, {"type": "alert_acknowledged", "alerts": [response]})
    await db.commit()
    return response


@router.post("/v1/alerts/{alert_id}/review")
async def submit_alert_review(
    alert_id: str,
    payload: AlertReviewInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    await require_alert_scope(db, admin, alert_id)
    result = await review_alert(db, alert_id, payload.decision, admin.get("sub", "unknown"), payload.reason)
    if "auditEvent" in result:
        await enqueue_changed(db)
    await db.commit()
    return result


@router.post("/v1/alert-warnings/{subject_id}/reset")
async def reset_alert_warnings(
    subject_id: str,
    payload: WarningResetInput,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    await require_subject_scope(db, admin, subject_id)
    result = await reset_subject_warnings(db, subject_id, admin.get("sub", "unknown"), payload.reason)
    if "auditEvent" in result:
        await enqueue_changed(db)
    await db.commit()
    return result


@router.post("/v1/alerts/{alert_id}/release-entry-restriction")
async def release_entry_restriction(
    alert_id: str,
    payload: EntryRestrictionRelease,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Lift a critical hold explicitly, without changing normal access or presence."""
    await require_alert_scope(db, admin, alert_id)
    result = await release_critical_entry_restriction(db, alert_id, admin.get("sub", "unknown"), payload.reason)
    await enqueue_changed(db)
    await db.commit()
    return result


# ---------------------------------------------------------------------------
# POST /v1/alerts/evaluate  (placeholder)
# ---------------------------------------------------------------------------

@router.post("/v1/alerts/evaluate")
async def evaluate_alerts(
    _admin: dict = Depends(verify_admin_request),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Run the same rule evaluation used by the scheduled worker."""
    predicted_response = {"triggered": 99_999_999, "message": "Alert rules evaluated"}
    await precharge_mutation_response(db, predicted_response)
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
