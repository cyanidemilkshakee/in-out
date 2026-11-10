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
    result = await _expire_request(request_id)
    # Let workflows that were started under the old deadline policy recognize
    # that the database no longer expires visitor approvals and wait for a signal
    # instead of repeatedly polling the non-expiring request.
    if isinstance(result, dict) and result.get("status") == "pending":
        return {**result, "_visitorDeadlineDisabled": True}
    return result


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import (CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES, evaluate_scheduled_rules,
        evaluate_continuous_presence_rules, build_workday_statuses)
    from models import (AccessPermission, AlertRuleAssignment, Alert as AlertModel, Checkpoint,
        Movement as MovementModel, OrganizationZone, Person, PresenceState, Subject,
        TerminalCheckpointAssignment)
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
        # Check all capacity bounds in one round trip. Each subquery stops at
        # cap+1, so this retains fail-closed behavior without full-table counts.
        capacity_limits = (
            (subjects_query, "subjects", settings.ALERT_EVALUATION_MAX_SUBJECTS),
            (people_query, "people", settings.ALERT_EVALUATION_MAX_SUBJECTS),
            (movements_query, "movements", settings.ALERT_EVALUATION_MAX_MOVEMENTS),
            (alerts_query, "alerts", settings.ALERT_EVALUATION_MAX_ALERTS),
        )
        capacity_select = select(*(
            select(func.count()).select_from(query.limit(maximum + 1).subquery())
                .scalar_subquery().label(resource)
            for query, resource, maximum in capacity_limits
        ))
        capacity_counts = (await db.execute(capacity_select)).mappings().one()
        for _, resource, maximum in capacity_limits:
            if capacity_counts[resource] > maximum:
                reject_capacity(resource, maximum)

        rules = await alert_rule_catalog(db, maximum_rows=settings.ALERT_EVALUATION_MAX_RULES)
        if not rules:
            return 0

        async def evaluate_checkpoint_offline_alerts():
            """Open or resolve one offline alert for each assigned checkpoint."""
            timeout = timedelta(minutes=CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES)
            rule = next((item for item in rules
                if item.get("conditionKey") == "checkpoint_offline" and item.get("enabled") is True), None)
            if rule is None:
                return [], 0

            assignment_rows = require_complete((await db.execute(
                select(TerminalCheckpointAssignment, Checkpoint)
                .join(Checkpoint, Checkpoint.id == TerminalCheckpointAssignment.checkpoint_id)
                .where(Checkpoint.active.is_(True))
                .order_by(Checkpoint.id, TerminalCheckpointAssignment.terminal_identity)
                .limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1)
                .with_for_update(of=TerminalCheckpointAssignment)
            )).all(), "terminal_assignments", settings.ALERT_EVALUATION_MAX_SUBJECTS)

            checkpoints = {}
            for assignment, checkpoint in assignment_rows:
                last_seen = assignment.last_heartbeat_at or assignment.updated_at
                current = checkpoints.setdefault(checkpoint.id, {
                    "checkpoint": checkpoint,
                    "terminalCount": 0,
                    "lastSeen": last_seen,
                    "lastHeartbeatAt": assignment.last_heartbeat_at,
                })
                current["terminalCount"] += 1
                if last_seen > current["lastSeen"]:
                    current["lastSeen"] = last_seen
                if (assignment.last_heartbeat_at is not None and
                        (current["lastHeartbeatAt"] is None or
                         assignment.last_heartbeat_at > current["lastHeartbeatAt"])):
                    current["lastHeartbeatAt"] = assignment.last_heartbeat_at

            unresolved_rows = require_complete((await db.scalars(select(AlertModel)
                .where(AlertModel.data["conditionKey"].astext == "checkpoint_offline",
                    AlertModel.data["status"].astext != "resolved")
                .order_by(AlertModel.created_at, AlertModel.id)
                .limit(settings.ALERT_EVALUATION_MAX_ALERTS + 1)
                .with_for_update())).all(), "checkpoint_offline_alerts", settings.ALERT_EVALUATION_MAX_ALERTS)
            unresolved_by_checkpoint = {}
            for alert_row in unresolved_rows:
                data = alert_row.data if isinstance(alert_row.data, dict) else {}
                checkpoint_id = data.get("checkpointId")
                if isinstance(checkpoint_id, str):
                    unresolved_by_checkpoint.setdefault(checkpoint_id, []).append(alert_row)

            cutoff = evaluation_now - timeout
            changes, created = [], 0
            from movement_logic import _current_date, _current_time

            # An assignment removed or a terminal resumed heartbeat clears its
            # alert. A later outage can then create a fresh alert for that zone.
            for checkpoint_id, rows in unresolved_by_checkpoint.items():
                checkpoint_state = checkpoints.get(checkpoint_id)
                is_online = checkpoint_state is None or checkpoint_state["lastSeen"] >= cutoff
                if not is_online:
                    continue
                for alert_row in rows:
                    data = alert_row.data if isinstance(alert_row.data, dict) else {}
                    resolved = {**data, "status": "resolved", "resolvedAt": evaluation_now.isoformat(),
                        "resolvedBy": "System", "resolutionReason": (
                            "A terminal heartbeat resumed." if checkpoint_state is not None
                            else "No terminal is assigned to this checkpoint.")}
                    alert_row.data = resolved
                    changes.append(resolved)

            for checkpoint_id, state in checkpoints.items():
                if state["lastSeen"] >= cutoff or unresolved_by_checkpoint.get(checkpoint_id):
                    continue
                checkpoint = state["checkpoint"]
                checkpoint_name = ((checkpoint.data or {}).get("gateLabel") or
                    (checkpoint.data or {}).get("name") or checkpoint.id)
                latest_heartbeat = state["lastHeartbeatAt"]
                last_heartbeat_text = latest_heartbeat.isoformat() if latest_heartbeat else None
                offline_since = (state["lastSeen"] + timeout).isoformat()
                alert_id = f"AL-{uuid.uuid4().hex[:8].upper()}"
                alert_data = {
                    "id": alert_id,
                    "severity": rule.get("severity", "high"),
                    "status": "open",
                    "title": rule.get("name", "Checkpoint terminal offline"),
                    "reason": (f"No heartbeat has been received from any of the "
                        f"{state['terminalCount']} assigned terminal(s) at {checkpoint_name} "
                        "for at least 5 minutes."),
                    "subjectName": "Checkpoint terminal",
                    "barcode": "",
                    "checkpoint": checkpoint_name,
                    "checkpointId": checkpoint_id,
                    "zoneId": checkpoint.zone_id,
                    "terminalCount": state["terminalCount"],
                    "lastHeartbeatAt": last_heartbeat_text,
                    "offlineSince": offline_since,
                    "timeoutSeconds": int(timeout.total_seconds()),
                    "date": _current_date(evaluation_now),
                    "time": _current_time(evaluation_now),
                    "category": rule.get("category", "operational"),
                    "ruleId": rule["id"],
                    "conditionKey": "checkpoint_offline",
                    "explanation": ("A checkpoint is considered online while at least one assigned terminal "
                        "sends a heartbeat within the previous five minutes. Browser terminals send one "
                        "every minute; certificate terminals can use the mTLS heartbeat endpoint."),
                    "createdAt": evaluation_now.isoformat(),
                }
                db.add(AlertModel(id=alert_id, created_at=evaluation_now, data=alert_data))
                changes.append(alert_data)
                created += 1
            return changes, created

        checkpoint_alert_changes, checkpoint_alerts_created = await evaluate_checkpoint_offline_alerts()

        async def evaluate_subjects(subject_ids, *, scoped=False):
            """Read complete current inputs; the second pass refreshes ORM state."""
            assignments = (await db.scalars(select(AlertRuleAssignment)
                .where(AlertRuleAssignment.subject_id.in_(subject_ids))
                .execution_options(populate_existing=True))).all()
            rule_assignments = {row.subject_id: row.rule_ids if isinstance(row.rule_ids, list) else []
                for row in assignments if row.rules_customized}
            skip_dates = {row.subject_id: row.irregularity_skip_dates
                if isinstance(row.irregularity_skip_dates, list) else [] for row in assignments}
            # Daily irregularity checks need only these authoritative movement
            # columns. No-break alerts use current continuous presence below.
            # Avoid loading every retained scan/asset JSON document.
            movement_query = select(MovementModel.subject_id, MovementModel.result, MovementModel.direction,
                MovementModel.subject_type, MovementModel.occurred_at).where(MovementModel.occurred_at >= since)
            if scoped:
                movement_query = movement_query.where(MovementModel.subject_id.in_(subject_ids))
            movement_rows = require_complete(list((await db.execute(movement_query
                .order_by(MovementModel.occurred_at, MovementModel.id)
                .limit(settings.ALERT_EVALUATION_MAX_MOVEMENTS + 1)
                .execution_options(populate_existing=True))).all()), "movements", settings.ALERT_EVALUATION_MAX_MOVEMENTS)
            from movement_logic import _current_date, _current_time
            movements = [{"subjectId": m.subject_id, "result": m.result, "direction": m.direction,
                "subjectType": m.subject_type, "createdAt": m.occurred_at.isoformat(),
                "date": _current_date(m.occurred_at), "time": _current_time(m.occurred_at)} for m in movement_rows]
            people_rows = require_complete((await db.execute(
                select(Person, Subject).join(Subject, Subject.id == Person.subject_id)
                .where(Subject.id.in_(subject_ids)).limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1)
                .execution_options(populate_existing=True))).all(), "people", settings.ALERT_EVALUATION_MAX_SUBJECTS)
            people = [{**current_subject_metadata(subject.kind, person.data),
                "id": subject.id, "barcode": subject.barcode, "type": subject.kind}
                for person, subject in people_rows]
            existing_query = select(AlertModel.data).where(AlertModel.created_at >= since)
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
            triggered = evaluate_scheduled_rules(rules, movements, [], existing,
                employees=people, now=evaluation_now, rule_assignments=rule_assignments,
                irregularity_skip_dates=skip_dates)
            # Continuous-presence rules use authoritative current state,
            # independent of retained scan history or workday summaries.
            continuous_presence_rows = require_complete((await db.execute(select(PresenceState, Subject, Person.data,
                AccessPermission.data, OrganizationZone.name)
                .join(Subject, Subject.id == PresenceState.subject_id)
                .outerjoin(Person, Person.subject_id == Subject.id)
                .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
                .outerjoin(OrganizationZone, OrganizationZone.id == PresenceState.entry_building_id)
                .where(Subject.id.in_(subject_ids), Subject.kind.in_(("employee", "visitor")),
                       PresenceState.state == "inside", PresenceState.entry_started_at.is_not(None))
                .limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1)
                .execution_options(populate_existing=True))).all(), "continuous_presence", settings.ALERT_EVALUATION_MAX_SUBJECTS)
            presences = {presence.subject_id: presence for presence, _, _, _, _ in continuous_presence_rows}
            visits = [{"subjectId": subject.id, "subjectType": subject.kind,
                "subjectName": (metadata if isinstance(metadata, dict) else {}).get("name") or subject.barcode,
                "barcode": subject.barcode, "state": presence.state, "buildingId": presence.entry_building_id,
                "buildingName": zone_name,
                "entryStartedAt": presence.entry_started_at,
                "permissionValidTo": ((permission_data or {}).get("validTo")
                    or (metadata if isinstance(metadata, dict) else {}).get("validTo")),
                "alertedPermissionValidTo": presence.visitor_permission_overstay_alerted_valid_to,
                "noBreakAlertedInterval": presence.no_break_alerted_interval}
                for presence, subject, metadata, permission_data, zone_name in continuous_presence_rows]
            continuous_alerts = evaluate_continuous_presence_rules(
                rules, visits, now=evaluation_now, rule_assignments=rule_assignments)
            return [*triggered, *continuous_alerts], continuous_alerts, presences

        # Build candidates without locking the entire roster or blocking scans.
        subject_ids = require_complete(list((await db.scalars(subjects_query.order_by(Subject.id)
            .limit(settings.ALERT_EVALUATION_MAX_SUBJECTS + 1))).all()), "subjects", settings.ALERT_EVALUATION_MAX_SUBJECTS)
        candidates, _, _ = await evaluate_subjects(subject_ids)
        candidate_ids = sorted({alert["subjectId"] for alert in candidates})
        if not candidate_ids:
            if checkpoint_alert_changes:
                await _enqueue_alert_batches(db, checkpoint_alert_changes)
                await db.commit()
            return checkpoint_alerts_created
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
        triggered, continuous_alerts, continuous_presences = await evaluate_subjects(locked_ids, scoped=True)
        for alert_data in continuous_alerts:
            presence = continuous_presences[alert_data["subjectId"]]
            if alert_data.get("conditionKey") == "visitor_overstay":
                presence.visitor_permission_overstay_alerted_valid_to = datetime.fromisoformat(
                    alert_data["permissionValidTo"].replace("Z", "+00:00"))
            elif alert_data.get("conditionKey") == "no_break":
                presence.no_break_alerted_interval = max(
                    presence.no_break_alerted_interval or 0,
                    alert_data["intervalIndex"],
                )
        alert_rows = []
        for alert_data in triggered:
            alert_id = (alert_data["id"] if alert_data.get("conditionKey") in {"visitor_overstay", "no_break"}
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
        emitted_alerts = [*triggered, *checkpoint_alert_changes]
        if emitted_alerts:
            await _enqueue_alert_batches(db, emitted_alerts)
        await db.commit()
        return len(triggered) + checkpoint_alerts_created
