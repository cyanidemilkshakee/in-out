"""
Temporal Activities for the InOut backend.
All activities interact with the database or Redis and are independently retryable.
"""
from __future__ import annotations

import json
import uuid
import logging
from datetime import datetime, timezone

from temporalio import activity
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import async_session  # use the session factory directly in activities
from models import (
    PermissionRequestModel, AccessPermission, AdminAccount,
    Alert, Notification, AuditEvent, Movement, PresenceState, Subject
)
from redis_client import publish_presence_update

logger = logging.getLogger(__name__)


@activity.defn
async def notify_admins_of_override(request_id: str) -> None:
    """Insert a high-priority notification for the pending override request."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        notif_id = f"NOT-{uuid.uuid4().hex[:8].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        notif_data = req.data or {}
        notification = Notification(
            id=notif_id,
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


@activity.defn
async def approve_override(request_id: str, admin_id: str, reason: str) -> dict:
    """Approve a manual override: flip request status, generate a movement, update presence."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")

        data = dict(req.data)
        data["status"] = "approved"
        req.data = data

        subject_id = data["subjectId"]
        checkpoint_id = data.get("checkpointId", "unknown")

        subject_stmt = select(Subject).where(Subject.id == subject_id)
        subject_obj = (await db.execute(subject_stmt)).scalar_one_or_none()
        subject_kind = subject_obj.kind if subject_obj else "employee"
        subject_barcode = subject_obj.barcode if subject_obj else "unknown"

        lock_stmt = select(PresenceState).where(PresenceState.subject_id == subject_id).with_for_update()
        presence = (await db.execute(lock_stmt)).scalar_one_or_none()
        if not presence:
            presence = PresenceState(subject_id=subject_id, state="outside")
            db.add(presence)
            await db.flush()

        new_state = "inside" if presence.state == "outside" else "outside"
        now = datetime.now(timezone.utc)
        presence.state = new_state
        presence.last_scan_timestamp = now

        movement = Movement(
            subject_id=subject_id,
            checkpoint_id=checkpoint_id,
            occurred_at=now,
            result="approved",
            direction="entry" if new_state == "inside" else "exit",
            scan_type="manual",
            sync_state="queued",
            subject_type=subject_kind,
            data={"overrideRequestId": request_id, "adminId": admin_id, "reason": reason},
        )
        db.add(movement)

        audit = AuditEvent(
            id=f"AUD-{uuid.uuid4().hex[:8].upper()}",
            data={
                "category": "permission",
                "action": "Manual override approved",
                "subjectId": subject_id,
                "actor": admin_id,
                "role": "Administrator",
                "decision": "granted",
                "reason": reason,
                "relatedId": request_id,
                "createdAt": now.isoformat(),
            }
        )
        db.add(audit)
        await db.commit()

        await publish_presence_update(json.dumps({
            "subject_id": subject_id,
            "kind": subject_kind,
            "barcode": subject_barcode,
            "state": new_state,
            "timestamp": now.isoformat(),
        }))
        return data


@activity.defn
async def deny_override(request_id: str, reason: str) -> dict:
    """Deny a manual override request."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        data = dict(req.data)
        data["status"] = "denied"
        req.data = data
        now = datetime.now(timezone.utc).isoformat()
        notif_id = f"NOT-{uuid.uuid4().hex[:8].upper()}"
        notification = Notification(
            id=notif_id,
            data={
                "id": notif_id,
                "title": "Override Request Denied",
                "message": f"Request {request_id} was denied: {reason}",
                "category": "permission_change",
                "priority": "high",
                "relatedId": request_id,
                "href": f"/admin/permissions?request={request_id}",
                "createdAt": now,
                "read": False,
            }
        )
        db.add(notification)
        await db.commit()
        return data


@activity.defn
async def auto_deny_override(request_id: str) -> None:
    """Auto-deny an override after the 10-minute timeout."""
    await deny_override(request_id, "No admin responded within the timeout period.")


@activity.defn
async def approve_visitor(request_id: str, reason: str) -> None:
    """Approve a visitor request: set status pre_approved, update permission."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        data = dict(req.data)
        data["status"] = "approved"
        req.data = data
        subject_id = data["subjectId"]
        perm_stmt = select(AccessPermission).where(AccessPermission.subject_id == subject_id)
        perm = (await db.execute(perm_stmt)).scalar_one_or_none()
        if perm:
            perm_data = dict(perm.data)
            perm_data["state"] = "active"
            perm_data["reason"] = reason
            perm.data = perm_data
        await db.commit()


@activity.defn
async def deny_visitor(request_id: str, reason: str) -> None:
    """Deny a visitor request."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        data = dict(req.data)
        data["status"] = "denied"
        req.data = data
        await db.commit()


@activity.defn
async def auto_deny_visitor(request_id: str) -> None:
    """Auto-deny a visitor after the 30-minute approval window."""
    await deny_visitor(request_id, "No admin responded within the approval window.")


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import evaluate_scheduled_rules, build_workday_statuses
    from models import AlertRule, Alert as AlertModel, Movement as MovementModel, Person
    from datetime import timedelta
    import uuid
    async with async_session() as db:
        since = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        rules_result = await db.execute(
            select(AlertRule).where(AlertRule.data["enabled"].as_boolean() == True)
        )
        rules = [r.data for r in rules_result.scalars().all()]
        if not rules:
            return 0
        movements_result = await db.execute(
            select(MovementModel).where(MovementModel.occurred_at >= since).order_by(MovementModel.occurred_at)
        )
        movements = [m.data for m in movements_result.scalars().all()]
        people_result = await db.execute(select(Person))
        people = [p.data for p in people_result.scalars().all()]
        existing_result = await db.execute(
            select(AlertModel).where(AlertModel.created_at >= since)
        )
        existing_alerts = [a.data for a in existing_result.scalars().all()]
        workdays = build_workday_statuses(movements, people)
        triggered = evaluate_scheduled_rules(rules, movements, workdays, existing_alerts)
        for alert_data in triggered:
            alert_id = f"AL-{uuid.uuid4().hex[:8].upper()}"
            alert_data["id"] = alert_id
            db.add(AlertModel(id=alert_id, data=alert_data))
        await db.commit()
        return len(triggered)
