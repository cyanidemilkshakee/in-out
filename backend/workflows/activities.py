"""
Temporal Activities for the InOut backend.
All activities interact with the database or Redis and are independently retryable.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from temporalio import activity
from sqlalchemy import select, func

from database import async_session  # use the session factory directly in activities
from models import PermissionRequestModel, Notification

@activity.defn
async def notify_admins_of_override(request_id: str) -> None:
    """Insert a high-priority notification for the pending override request."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id).with_for_update()
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        notif_id = f"NOT-override-{request_id}"
        if req.data.get("status") != "pending" or await db.get(Notification, notif_id):
            return
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        notification = Notification(
            id=notif_id,
            created_at=now_dt,
            data={
                "id": notif_id,
                "title": "Manual Override Pending",
                "message": f"Override request {request_id} awaiting admin decision.",
                "category": "approval_request",
                "priority": "high",
                "relatedId": request_id,
                "href": f"/admin/permissions?request={request_id}",
                "createdAt": now,
                "read": False,
            }
        )
        db.add(notification)
        await db.commit()


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
    from rule_engine import evaluate_scheduled_rules, build_workday_statuses, default_alert_rules, with_default_alert_rules
    from models import AlertRule, Alert as AlertModel, Movement as MovementModel, Person
    from datetime import timedelta
    import uuid
    async with async_session() as db:
        # Manual evaluations and worker retries must not duplicate alerts.
        await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("scheduled-alert-evaluation", 0))))
        # Compare PostgreSQL timestamptz columns with a datetime value, not an
        # ISO string. Passing the string makes asyncpg bind VARCHAR and causes
        # ``timestamptz >= varchar`` failures in the cron activity.
        since = datetime.now(timezone.utc) - timedelta(hours=48)
        rules_result = await db.execute(select(AlertRule))
        rules = with_default_alert_rules([r.data for r in rules_result.scalars().all()] or default_alert_rules())
        if not rules:
            return 0
        movements_result = await db.execute(
            select(MovementModel).where(MovementModel.occurred_at >= since).order_by(MovementModel.occurred_at)
        )
        from movement_logic import _current_date, _current_time
        movements = [{**m.data, "subjectId": m.subject_id, "result": m.result, "direction": m.direction,
            "subjectType": m.subject_type, "createdAt": m.occurred_at.isoformat(),
            "date": _current_date(m.occurred_at), "time": _current_time(m.occurred_at)} for m in movements_result.scalars().all()]
        people_result = await db.execute(select(Person))
        people = [{**p.data, "id": p.subject_id} for p in people_result.scalars().all()]
        existing_result = await db.execute(
            select(AlertModel).where(AlertModel.created_at >= since)
        )
        existing_alerts = [a.data for a in existing_result.scalars().all()]
        workdays = build_workday_statuses(movements, people)
        triggered = evaluate_scheduled_rules(rules, movements, workdays, existing_alerts)
        for alert_data in triggered:
            alert_id = f"AL-{uuid.uuid4().hex[:8].upper()}"
            alert_data["id"] = alert_id
            created_at = datetime.now(timezone.utc)
            alert_data["createdAt"] = created_at.isoformat()
            db.add(AlertModel(id=alert_id, data=alert_data, created_at=created_at))
        await db.commit()
        return len(triggered)
