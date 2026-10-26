"""
Temporal Activities for the InOut backend.
All activities interact with the database or Redis and are independently retryable.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from temporalio import activity
from sqlalchemy import select

from database import async_session  # use the session factory directly in activities
from redis_client import publish_presence_update
from event_outbox import enqueue_presence, MAX_EVENT_BYTES


async def _enqueue_alert_batches(db, alerts):
    """Keep each durable SSE record bounded without splitting the business commit."""
    chunks, chunk, size = [], [], len('{"type":"alerts","alerts":[]}')
    for alert in alerts:
        alert_size = len(json.dumps(alert, separators=(",", ":"), allow_nan=False).encode()) + 1
        if chunk and size + alert_size > MAX_EVENT_BYTES - 128:
            chunks.append(chunk)
            chunk, size = [], len('{"type":"alerts","alerts":[]}')
        chunk.append(alert)
        size += alert_size
    if chunk:
        chunks.append(chunk)
    for chunk in chunks:
        await enqueue_presence(db, {"type": "alerts", "alerts": chunk})

async def _apply_decision(request_id, decision, actor, reason):
    from permission_decisions import apply_permission_decision, enqueue_decision
    async with async_session() as db:
        result = await apply_permission_decision(db, request_id, decision, actor, reason, from_activity=True)
        if result.get("auditEvent"):
            await enqueue_decision(db, result)
        await db.commit()
    return result["request"]


async def _expire_request(request_id):
    from permission_decisions import apply_permission_decision, enqueue_decision
    async with async_session() as db:
        result = await apply_permission_decision(db, request_id, "denied", "system", "Approval deadline elapsed",
            from_activity=True, expire_only=True)
        if result.get("auditEvent"):
            await enqueue_decision(db, result)
        await db.commit()
    return result["request"]


@activity.defn
async def approve_override(request_id: str, admin_id: str, reason: str) -> dict:
    return await _apply_decision(request_id, "approved", admin_id, reason)


@activity.defn
async def deny_override(request_id: str, reason: str) -> dict:
    return await _apply_decision(request_id, "denied", "system", reason)


@activity.defn
async def auto_deny_override(request_id: str) -> Any:
    # Any preserves decoding of null results recorded by older worker builds.
    return await _expire_request(request_id)


@activity.defn
async def approve_visitor(request_id: str, reason: str) -> Any:
    return await _apply_decision(request_id, "approved", "system", reason)


@activity.defn
async def deny_visitor(request_id: str, reason: str) -> Any:
    return await _apply_decision(request_id, "denied", "system", reason)


@activity.defn
async def auto_deny_visitor(request_id: str) -> Any:
    return await _expire_request(request_id)


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import evaluate_scheduled_rules, evaluate_visitor_overstay_rules, build_workday_statuses
    from models import AlertRuleAssignment, Alert as AlertModel, Movement as MovementModel, OrganizationZone, Person, PresenceState, Subject
    from alert_rule_assignments import alert_rule_catalog
    from config import settings
    from fastapi import HTTPException
    from sqlalchemy import func, or_
    from sqlalchemy.exc import DBAPIError
    from critical_entry_restrictions import activate_critical_entry_restrictions
    from subject_metadata import current_subject_metadata
    from datetime import timedelta
    import uuid

    def reject_capacity(resource, maximum):
        raise HTTPException(503, detail={"code": "alert_evaluation_capacity_exceeded",
            "message": "Alert evaluation exceeds its configured capacity; no partial evaluation was performed",
            "resource": resource, "maximum": maximum})

    async def preflight_capacity(db, query, resource, maximum):
        # Count at most cap+1 identifiers, rather than materializing JSON or
        # counting an unbounded table. A cap is a rejection, never a sample.
        count = await db.scalar(select(func.count()).select_from(query.limit(maximum + 1).subquery()))
        if count > maximum:
            reject_capacity(resource, maximum)

    def require_complete(rows, resource, maximum):
        if len(rows) > maximum:
            reject_capacity(resource, maximum)
        return rows

    async with async_session() as db:
        # Do not queue evaluations behind another evaluator or an assignment
        # edit. Assignment mutations retain their blocking serialization lock.
        acquired = await db.scalar(select(func.pg_try_advisory_xact_lock(
            func.hashtextextended("scheduled-alert-evaluation", 0))))
        if not acquired:
            raise HTTPException(503, detail={"code": "alert_evaluation_busy",
                "message": "An alert evaluation or assignment change is already in progress"},
                headers={"Retry-After": "5"})
        evaluation_now = datetime.now(timezone.utc)
        since = evaluation_now - timedelta(hours=48)
        inside_presence = select(PresenceState.subject_id).where(
            PresenceState.subject_id == Subject.id, PresenceState.state == "inside").exists()
        subjects_query = select(Subject.id).where(or_(Subject.kind.in_(("employee", "hardware")),
            (Subject.kind == "visitor") & inside_presence))
        people_query = select(Person.subject_id).join(Subject, Subject.id == Person.subject_id).where(
            Subject.id.in_(subjects_query))
        movements_query = select(MovementModel.id).where(MovementModel.occurred_at >= since)
        alerts_query = select(AlertModel.id).where(AlertModel.created_at >= since)
        from models import AlertRule
        for query, resource, maximum in (
            (subjects_query, "subjects", settings.ALERT_EVALUATION_MAX_SUBJECTS),
            (people_query, "people", settings.ALERT_EVALUATION_MAX_SUBJECTS),
            (movements_query, "movements", settings.ALERT_EVALUATION_MAX_MOVEMENTS),
            (alerts_query, "alerts", settings.ALERT_EVALUATION_MAX_ALERTS),
            (select(AlertRule.id), "rules", settings.ALERT_EVALUATION_MAX_RULES),
        ):
            await preflight_capacity(db, query, resource, maximum)
        rules = await alert_rule_catalog(db, maximum_rows=settings.ALERT_EVALUATION_MAX_RULES)
        if not rules:
            return 0
        async def evaluate_subjects(subject_ids, *, scoped=False):
            """Read complete current inputs; the second pass refreshes ORM state."""
            assignments = (await db.scalars(select(AlertRuleAssignment)
                .where(AlertRuleAssignment.subject_id.in_(subject_ids))
                .execution_options(populate_existing=True))).all()
            rule_assignments = {row.subject_id: row.rule_ids if isinstance(row.rule_ids, list) else []
                for row in assignments if row.rules_customized}
            skip_dates = {row.subject_id: row.irregularity_skip_dates
                if isinstance(row.irregularity_skip_dates, list) else [] for row in assignments}
            movement_query = select(MovementModel).where(MovementModel.occurred_at >= since)
            if scoped:
                movement_query = movement_query.where(MovementModel.subject_id.in_(subject_ids))
            movement_rows = require_complete(list((await db.scalars(movement_query
                .order_by(MovementModel.occurred_at, MovementModel.id)
                .limit(settings.ALERT_EVALUATION_MAX_MOVEMENTS + 1)
                .execution_options(populate_existing=True))).all()), "movements", settings.ALERT_EVALUATION_MAX_MOVEMENTS)
            from movement_logic import _current_date, _current_time
            movements = [{**m.data, "subjectId": m.subject_id, "result": m.result, "direction": m.direction,
                "subjectType": m.subject_type, "createdAt": m.occurred_at.isoformat(),
                "date": _current_date(m.occurred_at), "time": _current_time(m.occurred_at)} for m in movement_rows]
            people_rows = require_complete((await db.execute(
                select(Person, Subject).join(Subject, Subject.id == Person.subject_id)
                .where(Subject.id.in_(subject_ids)).limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1)
                .execution_options(populate_existing=True))).all(), "people", settings.ALERT_EVALUATION_MAX_SUBJECTS)
            people = [{**current_subject_metadata(subject.kind, person.data),
                "id": subject.id, "barcode": subject.barcode, "type": subject.kind}
                for person, subject in people_rows]
            existing_query = select(AlertModel).where(AlertModel.created_at >= since)
            if scoped:
                # Preserve legacy alert deduplication by either the explicit
                # identity or the original barcode; names never bind identity.
                identifiers = {person["barcode"] for person in people} | set(subject_ids)
                existing_query = existing_query.where(or_(
                    AlertModel.data["subjectId"].astext.in_(subject_ids),
                    AlertModel.data["barcode"].astext.in_(identifiers)))
            existing = require_complete(list((await db.scalars(existing_query
                .limit(settings.ALERT_EVALUATION_MAX_ALERTS + 1)
                .execution_options(populate_existing=True))).all()), "alerts", settings.ALERT_EVALUATION_MAX_ALERTS)
            triggered = evaluate_scheduled_rules(rules, movements,
                build_workday_statuses(movements, people, now=evaluation_now), [row.data for row in existing],
                employees=people, now=evaluation_now, rule_assignments=rule_assignments,
                irregularity_skip_dates=skip_dates)
            # Continuous visits have no movement-history cutoff.
            visit_rows = require_complete((await db.execute(select(PresenceState, Subject, Person.data, OrganizationZone.name)
                .join(Subject, Subject.id == PresenceState.subject_id)
                .outerjoin(Person, Person.subject_id == Subject.id)
                .outerjoin(OrganizationZone, OrganizationZone.id == PresenceState.entry_building_id)
                .where(Subject.id.in_(subject_ids), Subject.kind == "visitor", PresenceState.state == "inside")
                .limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1)
                .execution_options(populate_existing=True))).all(), "visitor_presences", settings.ALERT_EVALUATION_MAX_SUBJECTS)
            presences = {presence.subject_id: presence for presence, _, _, _ in visit_rows}
            visits = [{"subjectId": subject.id, "subjectType": subject.kind,
                "subjectName": (metadata if isinstance(metadata, dict) else {}).get("name") or subject.barcode,
                "barcode": subject.barcode, "state": presence.state, "buildingId": presence.entry_building_id,
                "buildingName": zone_name,
                "entryStartedAt": presence.entry_started_at,
                "alertedEntryAt": presence.visitor_overstay_alerted_entry_at}
                for presence, subject, metadata, zone_name in visit_rows]
            visitor_alerts = evaluate_visitor_overstay_rules(rules, visits, now=evaluation_now)
            return [*triggered, *visitor_alerts], visitor_alerts, presences

        # Build candidates without locking the entire roster or blocking scans.
        subject_ids = require_complete(list((await db.scalars(subjects_query.order_by(Subject.id)
            .limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1))).all()), "subjects", settings.ALERT_EVALUATION_MAX_SUBJECTS)
        candidates, _, _ = await evaluate_subjects(subject_ids)
        candidate_ids = sorted({alert["subjectId"] for alert in candidates})
        if not candidate_ids:
            return 0
        # The evaluator/assignment advisory lock remains held. Match scan/review
        # lock order for only the affected identities, then discard optimistic
        # results and recompute from fresh committed inputs under those locks.
        try:
            locked_ids = list((await db.scalars(select(Subject.id).where(Subject.id.in_(candidate_ids))
                .order_by(Subject.id).with_for_update(nowait=True))).all())
        except DBAPIError as exc:
            if getattr(exc.orig, "sqlstate", None) == "55P03":
                raise HTTPException(503, detail={"code": "alert_evaluation_busy",
                    "message": "A subject is being updated; retry alert evaluation"},
                    headers={"Retry-After": "5"}) from exc
            raise
        triggered, visitor_alerts, visitor_presences = await evaluate_subjects(locked_ids, scoped=True)
        for alert_data in visitor_alerts:
            presence = visitor_presences[alert_data["subjectId"]]
            presence.visitor_overstay_alerted_entry_at = presence.entry_started_at
        alert_rows = []
        for alert_data in triggered:
            alert_id = (alert_data["id"] if alert_data.get("conditionKey") == "visitor_overstay"
                        else f"AL-{uuid.uuid4().hex[:8].upper()}")
            alert_data["id"] = alert_id
            created_at = datetime.now(timezone.utc)
            alert_data["createdAt"] = created_at.isoformat()
            alert_row = AlertModel(id=alert_id, data=alert_data, created_at=created_at)
            db.add(alert_row)
            alert_rows.append(alert_row)
        # Restriction and alert must become visible in the same commit. Scans
        # serialize on the same subject rows, so no acknowledged-alert gap exists.
        restrictions = await activate_critical_entry_restrictions(db, alert_rows)
        triggered = [{**row.data, "entryRestriction": restrictions.get(row.data.get("subjectId"))} for row in alert_rows]
        if triggered:
            await _enqueue_alert_batches(db, triggered)
        await db.commit()
        return len(triggered)
