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


async def _run_checkpoint_heartbeat_evaluation_once() -> int:
    """Monitor terminal heartbeats independently of people/movement capacity."""
    from datetime import timedelta
    import uuid
    from fastapi import HTTPException
    from sqlalchemy import func, select
    from database import async_session
    from event_outbox import enqueue_presence
    from models import Alert as AlertModel, Checkpoint, TerminalCheckpointAssignment, CheckpointEvaluationStatus
    from config import settings
    from alert_rule_assignments import alert_rule_catalog
    from rule_engine import CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES
    from movement_logic import _current_date, _current_time

    async def persist_success(db, *, completed_at, checkpoint_count, alert_count):
        status = await db.get(CheckpointEvaluationStatus, "checkpoint-heartbeat")
        if status is None:
            status = CheckpointEvaluationStatus(id="checkpoint-heartbeat")
            db.add(status)
        status.last_completed_at = completed_at
        status.checkpoints_evaluated = checkpoint_count
        status.alerts_created = alert_count

    async with async_session() as db:
        acquired = await db.scalar(select(func.pg_try_advisory_xact_lock(
            func.hashtextextended("checkpoint-heartbeat-evaluation", 0))))
        if not acquired:
            raise HTTPException(503, detail={"code": "checkpoint_evaluation_busy",
                "message": "A checkpoint heartbeat evaluation is already in progress"},
                headers={"Retry-After": "5"})
        rules = await alert_rule_catalog(db, maximum_rows=settings.ALERT_EVALUATION_MAX_RULES)
        rule = next((item for item in rules if item.get("conditionKey") == "checkpoint_offline"
            and item.get("enabled") is True), None)
        if rule is None:
            await persist_success(db, completed_at=datetime.now(timezone.utc), checkpoint_count=0, alert_count=0)
            await db.commit()
            return 0

        assignment_rows = (await db.execute(select(TerminalCheckpointAssignment, Checkpoint)
            .join(Checkpoint, Checkpoint.id == TerminalCheckpointAssignment.checkpoint_id)
            .where(Checkpoint.active.is_(True))
            .order_by(Checkpoint.id, TerminalCheckpointAssignment.terminal_identity)
            .limit(settings.CHECKPOINT_EVALUATION_MAX_CHECKPOINTS + 1)
            .with_for_update(of=TerminalCheckpointAssignment))).all()
        if len(assignment_rows) > settings.CHECKPOINT_EVALUATION_MAX_CHECKPOINTS:
            raise HTTPException(503, detail={"code": "checkpoint_evaluation_capacity_exceeded",
                "resource": "terminal_assignments", "maximum": settings.CHECKPOINT_EVALUATION_MAX_CHECKPOINTS})
        checkpoints = {}
        for assignment, checkpoint in assignment_rows:
            last_seen = assignment.last_heartbeat_at or assignment.updated_at
            if last_seen is None:
                last_seen = datetime.min.replace(tzinfo=timezone.utc)
            current = checkpoints.setdefault(checkpoint.id, {"checkpoint": checkpoint,
                "terminalCount": 0, "lastSeen": last_seen, "lastHeartbeatAt": assignment.last_heartbeat_at})
            current["terminalCount"] += 1
            if last_seen > current["lastSeen"]:
                current["lastSeen"] = last_seen
            if assignment.last_heartbeat_at is not None and (
                    current["lastHeartbeatAt"] is None or assignment.last_heartbeat_at > current["lastHeartbeatAt"]):
                current["lastHeartbeatAt"] = assignment.last_heartbeat_at

        unresolved = (await db.scalars(select(AlertModel)
            .where(AlertModel.data["conditionKey"].astext == "checkpoint_offline",
                AlertModel.data["status"].astext != "resolved")
            .order_by(AlertModel.created_at, AlertModel.id)
            .limit(settings.CHECKPOINT_EVALUATION_MAX_ALERTS + 1).with_for_update())).all()
        if len(unresolved) > settings.CHECKPOINT_EVALUATION_MAX_ALERTS:
            raise HTTPException(503, detail={"code": "checkpoint_evaluation_capacity_exceeded",
                "resource": "checkpoint_offline_alerts", "maximum": settings.CHECKPOINT_EVALUATION_MAX_ALERTS})
        by_checkpoint = {}
        for row in unresolved:
            checkpoint_id = (row.data or {}).get("checkpointId")
            if isinstance(checkpoint_id, str):
                by_checkpoint.setdefault(checkpoint_id, []).append(row)

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES)
        changes, created = [], 0
        for checkpoint_id, rows in by_checkpoint.items():
            state = checkpoints.get(checkpoint_id)
            if state is not None and state["lastSeen"] < cutoff:
                continue
            for row in rows:
                data = row.data or {}
                resolved = {**data, "status": "resolved", "resolvedAt": now.isoformat(),
                    "resolvedBy": "System", "resolutionReason": "A terminal heartbeat resumed."
                        if state else "No terminal is assigned to this checkpoint."}
                row.data = resolved
                changes.append(resolved)

        for checkpoint_id, state in checkpoints.items():
            if state["lastSeen"] >= cutoff or by_checkpoint.get(checkpoint_id):
                continue
            checkpoint = state["checkpoint"]
            name = ((checkpoint.data or {}).get("gateLabel") or (checkpoint.data or {}).get("name") or checkpoint.id)
            latest_heartbeat = state["lastHeartbeatAt"]
            alert_id = f"AL-{uuid.uuid4().hex[:8].upper()}"
            data = {"id": alert_id, "severity": rule.get("severity", "high"), "status": "open",
                "title": rule.get("name", "Checkpoint terminal offline"),
                "reason": (f"No heartbeat has been received from any of the {state['terminalCount']} assigned "
                    f"terminal(s) at {name} for at least {CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES} minutes."),
                "subjectName": "Checkpoint terminal", "barcode": "", "checkpoint": name,
                "checkpointId": checkpoint_id, "zoneId": checkpoint.zone_id,
                "terminalCount": state["terminalCount"],
                "lastHeartbeatAt": latest_heartbeat.isoformat() if latest_heartbeat else None,
                "offlineSince": (state["lastSeen"] + timedelta(minutes=CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES)).isoformat(),
                "timeoutSeconds": CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES * 60,
                "date": _current_date(now), "time": _current_time(now),
                "category": rule.get("category", "operational"), "ruleId": rule["id"],
                "conditionKey": "checkpoint_offline",
                "explanation": "A checkpoint is online while an assigned terminal sends a recent heartbeat.",
                "createdAt": now.isoformat()}
            db.add(AlertModel(id=alert_id, created_at=now, data=data))
            changes.append(data)
            created += 1
        if changes:
            await _enqueue_alert_batches(db, changes)
        await persist_success(db, completed_at=now, checkpoint_count=len(checkpoints), alert_count=created)
        await db.commit()
        return created


@activity.defn
async def run_checkpoint_heartbeat_evaluation() -> int:
    """Run independent checkpoint monitoring and retain an operational health result."""
    from database import async_session
    from models import CheckpointEvaluationStatus

    try:
        return await _run_checkpoint_heartbeat_evaluation_once()
    except Exception as error:
        detail = getattr(error, "detail", None)
        code = detail.get("code") if isinstance(detail, dict) else None
        error_code = (code if isinstance(code, str) else type(error).__name__)[:128]
        try:
            async with async_session() as db:
                status = await db.get(CheckpointEvaluationStatus, "checkpoint-heartbeat")
                if status is None:
                    status = CheckpointEvaluationStatus(id="checkpoint-heartbeat")
                    db.add(status)
                status.last_failed_at = datetime.now(timezone.utc)
                status.last_error_code = error_code
                await db.commit()
        except Exception:
            # Preserve the evaluation failure; health will remain stale if the
            # database also cannot save the failure marker.
            pass
        raise


@activity.defn
async def run_alert_rule_evaluation() -> int:
    """Evaluate scheduled alert rules and persist any newly triggered alerts."""
    from rule_engine import evaluate_scheduled_rules, evaluate_continuous_presence_rules
    from models import (AccessPermission, AlertRuleAssignment, Alert as AlertModel,
        Movement as MovementModel, OrganizationZone, Person, PresenceState, Subject)
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
        rules = await alert_rule_catalog(db, maximum_rows=settings.ALERT_EVALUATION_MAX_RULES)
        if not rules:
            return 0

        async def evaluate_subjects(subject_ids):
            """Read complete inputs for one bounded subject batch."""
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
                MovementModel.subject_type, MovementModel.occurred_at).where(
                    MovementModel.occurred_at >= since, MovementModel.subject_id.in_(subject_ids))
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
            # Preserve legacy alert deduplication by either the explicit
            # identity or original barcode; names never bind identity.
            identifiers = {person["barcode"] for person in people} | set(subject_ids)
            existing_query = existing_query.where(or_(
                AlertModel.data["subjectId"].astext.in_(subject_ids),
                AlertModel.data["barcode"].astext.in_(identifiers)))
            existing = require_complete(list((await db.scalars(existing_query
                .limit(settings.ALERT_EVALUATION_MAX_ALERTS + 1)
                .execution_options(populate_existing=True))).all()), "alerts", settings.ALERT_EVALUATION_MAX_ALERTS)
            try:
                configured_workdays = tuple(sorted({int(day.strip()) for day in settings.ATTENDANCE_WORKDAYS.split(",")
                    if day.strip()}))
                if any(day < 0 or day > 6 for day in configured_workdays):
                    raise ValueError("Attendance weekdays must be between 0 and 6")
            except (TypeError, ValueError):
                configured_workdays = (0, 1, 2, 3, 4)
            holidays = {day.strip() for day in settings.ATTENDANCE_HOLIDAYS.split(",") if day.strip()}
            triggered = evaluate_scheduled_rules(rules, movements, [], existing,
                employees=people, now=evaluation_now, rule_assignments=rule_assignments,
                irregularity_skip_dates=skip_dates, attendance_workdays=configured_workdays,
                attendance_cutoff_hour=settings.ATTENDANCE_CUTOFF_HOUR,
                attendance_cutoff_minute=settings.ATTENDANCE_CUTOFF_MINUTE,
                attendance_grace_minutes=settings.ATTENDANCE_GRACE_MINUTES,
                attendance_holidays=holidays)
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

        total_created = 0
        last_subject_id = None
        while True:
            page_query = subjects_query.order_by(Subject.id).limit(settings.ALERT_EVALUATION_MAX_SUBJECTS)
            if last_subject_id is not None:
                page_query = page_query.where(Subject.id > last_subject_id)
            subject_ids = list((await db.scalars(page_query)).all())
            if not subject_ids:
                break
            last_subject_id = subject_ids[-1]

            # The evaluator/assignment advisory lock remains held. Process a
            # bounded subject page at a time and lock only identities with a
            # candidate, then recompute from fresh committed inputs.
            candidates, _, _ = await evaluate_subjects(subject_ids)
            candidate_ids = sorted({alert["subjectId"] for alert in candidates})
            if not candidate_ids:
                continue
            try:
                locked_ids = list((await db.scalars(select(Subject.id).where(Subject.id.in_(candidate_ids))
                    .order_by(Subject.id).with_for_update(nowait=True))).all())
            except DBAPIError as exc:
                if getattr(exc.orig, "sqlstate", None) == "55P03":
                    raise HTTPException(503, detail={"code": "alert_evaluation_busy",
                        "message": "A subject is being updated; retry alert evaluation"},
                        headers={"Retry-After": "5"}) from exc
                raise
            triggered, continuous_alerts, continuous_presences = await evaluate_subjects(locked_ids)
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
            # Presence markers normally prevent repeat IDs. Reconcile against
            # the alert ledger as a second idempotency guard for retries and old rows.
            generated_ids = list(dict.fromkeys(alert_data.get("id") for alert_data in triggered
                if isinstance(alert_data.get("id"), str) and alert_data["id"]))
            existing_alert_rows = {}
            for offset in range(0, len(generated_ids), 1000):
                rows = (await db.scalars(select(AlertModel).where(
                    AlertModel.id.in_(generated_ids[offset:offset + 1000])).with_for_update())).all()
                existing_alert_rows.update({row.id: row for row in rows})
            # Older releases created one row at every six-hour boundary. When
            # the stable per-visit ID is first encountered, reuse an existing
            # row for that exact visit so the rollout does not create a fourth
            # open case beside its legacy interval alerts.
            no_break_keys = {(alert.get("subjectId"), alert.get("entryStartedAt"))
                for alert in triggered if alert.get("conditionKey") == "no_break"}
            if no_break_keys:
                legacy_rows = (await db.scalars(select(AlertModel).where(
                    AlertModel.data["conditionKey"].astext == "no_break",
                    AlertModel.data["subjectId"].astext.in_([subject_id for subject_id, _ in no_break_keys]),
                ).order_by(AlertModel.created_at, AlertModel.id)
                    .limit(settings.ALERT_EVALUATION_MAX_ALERTS + 1).with_for_update())).all()
                if len(legacy_rows) > settings.ALERT_EVALUATION_MAX_ALERTS:
                    reject_capacity("legacy_no_break_alerts", settings.ALERT_EVALUATION_MAX_ALERTS)
                legacy_by_visit = {}
                for row in legacy_rows:
                    data = row.data or {}
                    key = (data.get("subjectId"), data.get("entryStartedAt"))
                    if key in no_break_keys:
                        legacy_by_visit.setdefault(key, row)
                for alert_data in triggered:
                    if alert_data.get("conditionKey") != "no_break":
                        continue
                    stable_row = existing_alert_rows.get(alert_data.get("id"))
                    legacy_row = legacy_by_visit.get((alert_data.get("subjectId"), alert_data.get("entryStartedAt")))
                    if stable_row is None and legacy_row is not None:
                        alert_data["id"] = legacy_row.id
                        existing_alert_rows[legacy_row.id] = legacy_row
            new_triggered = []
            refreshed_alerts = []
            for alert_data in triggered:
                existing_row = existing_alert_rows.get(alert_data.get("id"))
                if existing_row is None:
                    new_triggered.append(alert_data)
                    continue
                if alert_data.get("conditionKey") == "no_break":
                    previous = dict(existing_row.data or {})
                    updated = {**previous,
                        "severity": "critical" if previous.get("severity") == "critical" else alert_data["severity"],
                        "reason": alert_data["reason"],
                        "intervalIndex": alert_data["intervalIndex"],
                        "reminderCount": max(int(previous.get("reminderCount", 0)),
                            int(alert_data["reminderCount"])),
                        "lastReminderAt": evaluation_now.isoformat(),
                        "explanation": alert_data["explanation"],
                    }
                    existing_row.data = updated
                    refreshed_alerts.append(updated)
            alert_rows = []
            for alert_data in new_triggered:
                alert_id = (alert_data["id"] if alert_data.get("conditionKey") in {"visitor_overstay", "no_break"}
                            else f"AL-{uuid.uuid4().hex[:8].upper()}")
                alert_data["id"] = alert_id
                created_at = datetime.now(timezone.utc)
                alert_data["createdAt"] = created_at.isoformat()
                alert_row = AlertModel(id=alert_id, data=alert_data, created_at=created_at)
                db.add(alert_row)
                alert_rows.append(alert_row)
            restrictions = await activate_critical_entry_restrictions(db, alert_rows)
            created_documents = [{**row.data,
                "entryRestriction": restrictions.get(row.data.get("subjectId"))} for row in alert_rows]
            emitted = [*created_documents, *refreshed_alerts]
            if emitted:
                await _enqueue_alert_batches(db, emitted)
            total_created += len(created_documents)

        await db.commit()
        return total_created
