"""
Temporal Activities for the InOut backend.
All activities interact with the database or Redis and are independently retryable.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from temporalio import activity
from sqlalchemy import select

from database import async_session  # use the session factory directly in activities
from models import (
    PermissionRequestModel, AccessPermission, Notification,
    AuditEvent, Movement, PresenceState, Subject, Person
)
from redis_client import publish_presence_update

@activity.defn
async def notify_admins_of_override(request_id: str) -> None:
    """Insert a high-priority notification for the pending override request."""
    async with async_session() as db:
        stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == request_id)
        req = (await db.execute(stmt)).scalar_one_or_none()
        if not req:
            raise ValueError(f"Permission request {request_id} not found")
        notif_id = f"NOT-{uuid.uuid4().hex[:8].upper()}"
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        notif_data = req.data or {}
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

        subject_id = data.get("subjectId") or None
        checkpoint_id = data.get("checkpointId", "unknown")

        subject_obj = None
        if subject_id:
            subject_stmt = select(Subject).where(Subject.id == subject_id)
            subject_obj = (await db.execute(subject_stmt)).scalar_one_or_none()
        subject_kind = subject_obj.kind if subject_obj else data.get("subjectType", "visitor")
        subject_barcode = subject_obj.barcode if subject_obj else data.get("barcode", "unknown")

        existing_movement = await db.execute(
            select(Movement).where(Movement.data["overrideRequestId"].astext == request_id).limit(1)
        )
        if existing_movement.scalars().first():
            await db.commit()
            return data

        now = datetime.now(timezone.utc)
        presence = None
        if subject_id:
            lock_stmt = select(PresenceState).where(PresenceState.subject_id == subject_id).with_for_update()
            presence = (await db.execute(lock_stmt)).scalar_one_or_none()
            if not presence:
                presence = PresenceState(subject_id=subject_id, state="outside")
                db.add(presence)
                await db.flush()

        direction = data.get("direction") if data.get("direction") in {"entry", "exit"} else ("entry" if not presence or presence.state == "outside" else "exit")
        new_state = "inside" if direction == "entry" else "outside"
        if presence:
            presence.state = new_state
            presence.last_scan_timestamp = now

        event_id = f"MAN-{uuid.uuid4().hex[:10].upper()}"
        event = {
            "id": event_id,
            "date": now.date().isoformat(),
            "time": now.strftime("%H:%M:%S"),
            "checkpointId": checkpoint_id,
            "checkpoint": data.get("checkpoint", checkpoint_id),
            "direction": direction,
            "subjectId": subject_id or "unregistered",
            "subjectName": data.get("subjectName") or subject_barcode,
            "subjectType": subject_kind,
            "barcode": subject_barcode,
            "result": "approved",
            "reason": reason or "Approved by administrator during manual review.",
            "scanType": "manual",
            "syncState": "queued",
            "hardwareIds": [],
            "createdAt": now.isoformat(),
            "overrideRequestId": request_id,
            "adminId": admin_id,
        }

        movement = Movement(
            id=event_id,
            subject_id=subject_id,
            checkpoint_id=checkpoint_id,
            occurred_at=now,
            result="approved",
            direction=direction,
            scan_type="manual",
            sync_state="queued",
            subject_type=subject_kind,
            data=event,
        )
        db.add(movement)

        audit_id = f"AUD-{uuid.uuid4().hex[:8].upper()}"
        audit = AuditEvent(
            id=audit_id,
            created_at=now,
            data={
                "id": audit_id,
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
            "type": "manual_review_decision",
            "requestId": request_id,
            "subject_id": subject_id,
            "kind": subject_kind,
            "barcode": subject_barcode,
            "state": new_state if subject_id else "unchanged",
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
        # A timeout can race with an already-persisted admin approval while
        # Temporal is reconnecting. Never turn an approved request into a
        # denial during that race.
        if data.get("status") == "approved":
            await db.commit()
            return data
        # The API applies a manual denial immediately and then signals the
        # waiting workflow. Keep the activity idempotent when that signal is
        # delivered after the direct application, but still repair older
        # denied requests that never got their manual movement.
        existing_movement_result = await db.execute(
            select(Movement).where(Movement.data["overrideRequestId"].astext == request_id).limit(1)
        )
        existing_movement = existing_movement_result.scalars().first()
        if data.get("status") == "denied" and existing_movement:
            await db.commit()
            return data
        data["status"] = "denied"
        req.data = data
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        subject_id = data.get("subjectId") or None
        subject_result = await db.execute(select(Subject).where(Subject.id == subject_id))
        subject = subject_result.scalar_one_or_none()
        subject_kind = subject.kind if subject else "visitor"
        subject_barcode = subject.barcode if subject else data.get("barcode", "unknown")
        checkpoint_id = data.get("checkpointId", "unknown")
        direction = data.get("direction") if data.get("direction") in {"entry", "exit"} else "entry"
        if not existing_movement:
            event_id = f"MAN-{uuid.uuid4().hex[:10].upper()}"
            event = {
                "id": event_id,
                "date": now_dt.date().isoformat(),
                "time": now_dt.strftime("%H:%M:%S"),
                "checkpointId": checkpoint_id,
                "checkpoint": data.get("checkpoint", checkpoint_id),
                "direction": direction,
                "subjectId": subject_id or "unregistered",
                "subjectName": data.get("subjectName") or subject_barcode,
                "subjectType": subject_kind,
                "barcode": subject_barcode,
                "result": "denied",
                "reason": reason or "Denied by administrator during manual review.",
                "denialCode": "manual_review",
                "scanType": "manual",
                "syncState": "queued",
                "hardwareIds": [],
                "createdAt": now,
                "overrideRequestId": request_id,
            }
            db.add(Movement(
                id=event_id,
                subject_id=subject_id,
                checkpoint_id=checkpoint_id,
                occurred_at=now_dt,
                result="denied",
                direction=direction,
                denial_code="manual_review",
                scan_type="manual",
                subject_type=subject_kind,
                sync_state="queued",
                data=event,
            ))
        notif_id = f"NOT-{uuid.uuid4().hex[:8].upper()}"
        notification = Notification(
            id=notif_id,
            created_at=now_dt,
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
        audit_id = f"AUD-{uuid.uuid4().hex[:8].upper()}"
        db.add(AuditEvent(
            id=audit_id,
            created_at=now_dt,
            data={
                "id": audit_id,
                "category": "permission",
                "action": "Manual override denied",
                "subjectId": subject_id or "",
                "actor": "Administrator",
                "role": "Administrator",
                "decision": "denied",
                "reason": reason,
                "relatedId": request_id,
                "createdAt": now,
            },
        ))
        if subject_id:
            perm_result = await db.execute(
                select(AccessPermission).where(AccessPermission.subject_id == subject_id).order_by(AccessPermission.id).limit(1)
            )
            perm = perm_result.scalars().first()
            if perm:
                perm.data = {**(perm.data or {}), "state": "restricted", "reason": reason}
            person_result = await db.execute(select(Person).where(Person.subject_id == subject_id))
            person = person_result.scalar_one_or_none()
            if person:
                person.data = {**(person.data or {}), "status": "restricted"}
        await db.commit()
        await publish_presence_update(json.dumps({
            "type": "manual_review_decision",
            "requestId": request_id,
            "subject_id": subject_id,
            "kind": "manual_decision",
            "barcode": subject_barcode,
            "state": "unchanged",
            "timestamp": now,
        }))
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
        perm_stmt = select(AccessPermission).where(AccessPermission.subject_id == subject_id).order_by(AccessPermission.id).limit(1)
        perm = (await db.execute(perm_stmt)).scalars().first()
        if perm:
            perm_data = dict(perm.data)
            perm_data["state"] = "active"
            perm_data["reason"] = reason
            perm_data["validFrom"] = data.get("validFrom", perm_data.get("validFrom", ""))
            perm_data["validTo"] = data.get("validTo", perm_data.get("validTo", ""))
            perm_data["zones"] = data.get("requestedZones", perm_data.get("zones", []))
            perm.data = perm_data
        person_result = await db.execute(select(Person).where(Person.subject_id == subject_id))
        person = person_result.scalar_one_or_none()
        if person:
            person.data = {
                **(person.data or {}),
                "status": "pre_approved",
                "validFrom": data.get("validFrom", person.data.get("validFrom", "")),
                "validTo": data.get("validTo", person.data.get("validTo", "")),
                "allowedZones": data.get("requestedZones", person.data.get("allowedZones", [])),
            }
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
        subject_id = data.get("subjectId")
        if subject_id:
            perm_result = await db.execute(select(AccessPermission).where(AccessPermission.subject_id == subject_id).order_by(AccessPermission.id).limit(1))
            perm = perm_result.scalars().first()
            if perm:
                perm.data = {**(perm.data or {}), "state": "restricted", "reason": reason}
            person_result = await db.execute(select(Person).where(Person.subject_id == subject_id))
            person = person_result.scalar_one_or_none()
            if person:
                person.data = {**(person.data or {}), "status": "restricted"}
        await db.commit()


@activity.defn
async def auto_deny_visitor(request_id: str) -> None:
    """Auto-deny a visitor after the 30-minute approval window."""
    await deny_visitor(request_id, "No admin responded within the approval window.")


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import evaluate_scheduled_rules, build_workday_statuses, default_alert_rules, with_default_alert_rules
    from models import AlertRule, Alert as AlertModel, Movement as MovementModel, Person
    from datetime import timedelta
    import uuid
    async with async_session() as db:
        # Compare PostgreSQL timestamptz columns with a datetime value, not an
        # ISO string. Passing the string makes asyncpg bind VARCHAR and causes
        # ``timestamptz >= varchar`` failures in the cron activity.
        since = datetime.now(timezone.utc) - timedelta(hours=48)
        rules_result = await db.execute(
            select(AlertRule).where(AlertRule.data["enabled"].as_boolean() == True)
        )
        rules = with_default_alert_rules([r.data for r in rules_result.scalars().all()] or default_alert_rules())
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
