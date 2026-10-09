"""
Temporal Activities for the InOut backend.
All activities interact with the database or Redis and are independently retryable.
"""
from __future__ import annotations

import uuid
import json
from datetime import datetime, timezone

from temporalio import activity
from sqlalchemy import select

from database import async_session  # use the session factory directly in activities
from redis_client import publish_presence_update

async def _apply_decision(request_id, decision, actor, reason):
    from permission_decisions import apply_permission_decision, publish_decision
    async with async_session() as db:
        result = await apply_permission_decision(db, request_id, decision, actor, reason, from_activity=True)
        await db.commit()
    await publish_decision(result)
    return result["request"]


@activity.defn
async def approve_override(request_id: str, admin_id: str, reason: str) -> dict:
    return await _apply_decision(request_id, "approved", admin_id, reason)


@activity.defn
async def deny_override(request_id: str, reason: str) -> dict:
    return await _apply_decision(request_id, "denied", "system", reason)


@activity.defn
async def auto_deny_override(request_id: str) -> None:
    await deny_override(request_id, "No admin responded within the timeout period.")


@activity.defn
async def approve_visitor(request_id: str, reason: str) -> None:
    await _apply_decision(request_id, "approved", "system", reason)


@activity.defn
async def deny_visitor(request_id: str, reason: str) -> None:
    await _apply_decision(request_id, "denied", "system", reason)


@activity.defn
async def auto_deny_visitor(request_id: str) -> None:
    await deny_visitor(request_id, "No admin responded within the approval window.")


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import evaluate_scheduled_rules, build_workday_statuses
    from models import AlertRuleAssignment, Alert as AlertModel, Movement as MovementModel, Person, Subject
    from alert_rule_assignments import assignment_rule_catalog, lock_scheduled_alert_evaluation
    from critical_entry_restrictions import activate_critical_entry_restrictions
    from subject_metadata import current_subject_metadata
    from datetime import timedelta
    import uuid
    async with async_session() as db:
        # Manual evaluations and worker retries must not duplicate alerts.
        await lock_scheduled_alert_evaluation(db)
        # Match scan/review lock order before reading workdays and assignments.
        # The advisory lock also serializes complete selection replacements.
        subject_ids = list((await db.scalars(select(Subject.id)
            .where(Subject.kind.in_(("employee", "hardware")))
            .order_by(Subject.id).with_for_update())).all())
        # Compare PostgreSQL timestamptz columns with a datetime value, not an
        # ISO string. Passing the string makes asyncpg bind VARCHAR and causes
        # ``timestamptz >= varchar`` failures in the cron activity.
        since = datetime.now(timezone.utc) - timedelta(hours=48)
        rules = await assignment_rule_catalog(db)
        if not rules:
            return 0
        assignments = (await db.scalars(select(AlertRuleAssignment)
            .where(AlertRuleAssignment.subject_id.in_(subject_ids)))).all()
        rule_assignments = {row.subject_id: row.rule_ids if isinstance(row.rule_ids, list) else []
            for row in assignments if row.rules_customized}
        irregularity_skip_dates = {row.subject_id: row.irregularity_skip_dates if isinstance(row.irregularity_skip_dates, list) else [] for row in assignments}
        movements_result = await db.execute(
            select(MovementModel).where(MovementModel.occurred_at >= since).order_by(MovementModel.occurred_at)
        )
        from movement_logic import _current_date, _current_time
        movements = [{**m.data, "subjectId": m.subject_id, "result": m.result, "direction": m.direction,
            "subjectType": m.subject_type, "createdAt": m.occurred_at.isoformat(),
            "date": _current_date(m.occurred_at), "time": _current_time(m.occurred_at)} for m in movements_result.scalars().all()]
        people_result = await db.execute(
            select(Person, Subject).join(Subject, Subject.id == Person.subject_id)
        )
        people = [
            {
                **current_subject_metadata(subject.kind, person.data),
                "id": subject.id,
                "barcode": subject.barcode,
                "type": subject.kind,
            }
            for person, subject in people_result.all()
        ]
        existing_result = await db.execute(
            select(AlertModel).where(AlertModel.created_at >= since)
        )
        existing_alerts = [a.data for a in existing_result.scalars().all()]
        evaluation_now = datetime.now(timezone.utc)
        workdays = build_workday_statuses(movements, people, now=evaluation_now)
        triggered = evaluate_scheduled_rules(
            rules,
            movements,
            workdays,
            existing_alerts,
            employees=people,
            now=evaluation_now,
            rule_assignments=rule_assignments,
            irregularity_skip_dates=irregularity_skip_dates,
        )
        alert_rows = []
        for alert_data in triggered:
            alert_id = f"AL-{uuid.uuid4().hex[:8].upper()}"
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
        await db.commit()
        if triggered:
            try:
                await publish_presence_update(json.dumps({
                    "type": "alerts",
                    "alerts": triggered,
                }))
            except Exception:
                # Alert persistence must not fail because an SSE subscriber is
                # temporarily unavailable.
                pass
        return len(triggered)
