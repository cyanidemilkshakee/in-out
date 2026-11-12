"""
rule_engine.py
--------------
Python port of lib/ruleEngine.ts.

Public API
----------
build_workday_statuses(movements, people) -> list[dict]
evaluate_scheduled_rules(rules, movements, workdays, existing_alerts) -> list[dict]
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, TypedDict

# ---------------------------------------------------------------------------
# TypedDicts (mirror of types.ts — minimal subset needed here)
# ---------------------------------------------------------------------------

Direction = Literal["entry", "exit"]
ResultStatus = Literal["approved", "denied"]
SyncState = Literal["synced", "queued", "conflict"]
SubjectType = Literal["employee", "visitor", "hardware"]

AlertSeverity = Literal["critical", "high", "medium"]
AlertStatus = Literal["open", "acknowledged", "warned", "resolved"]
AlertCategory = Literal["access_violation", "presence_anomaly", "hardware_custody", "operational"]
ConditionKey = Literal[
    "no_break",
    "irregularity",
    "cross_building_scan",
    # Kept as a stable persisted key while the rule now covers all people.
    "visitor_overstay",
    "scan_burst",
    "checkpoint_denial_rate",
    "checkpoint_offline",
]

SYSTEM_ALERT_CONDITIONS = frozenset({"scan_burst", "checkpoint_denial_rate", "checkpoint_offline"})
CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES = 5

RETIRED_ALERT_RULE_IDS = frozenset({
    "rule-exit-balance",
    "rule-restricted-entry",
    "rule-unauthorized-hardware",
})
RETIRED_ALERT_CONDITIONS = frozenset({
    "exit_balance",
    "restricted_employee_entry",
    "unauthorized_hardware_carrier",
})
_IST = timezone(timedelta(hours=5, minutes=30))

DEFAULT_ALERT_RULES: list[dict[str, object]] = [
    {
        "id": "rule-no-break",
        "name": "Continuous presence",
        "description": "Track one alert case per visit when an employee remains inside without an approved exit.",
        "category": "operational",
        "severity": "medium",
        "enabled": True,
        "scope": "Employees currently inside",
        "conditionKey": "no_break",
        "recentTriggers": 0,
    },
    {
        "id": "rule-irregularity",
        "name": "Irregularity",
        "description": "Alert on scheduled workdays when an active employee has no approved entry by the configured cutoff and grace period.",
        "category": "presence_anomaly",
        "severity": "medium",
        "enabled": True,
        "scope": "Employee attendance",
        "conditionKey": "irregularity",
        "recentTriggers": 0,
    },
    {
        "id": "rule-cross-building-scan",
        "name": "Scan in another zone",
        "description": "Alert when an employee or visitor scans in another zone while recorded inside a zone.",
        "category": "presence_anomaly",
        "severity": "high",
        "enabled": True,
        "scope": "Employees and visitors",
        "conditionKey": "cross_building_scan",
        "recentTriggers": 0,
    },
    {
        "id": "rule-visitor-overstay",
        "name": "Visitor permission overstay",
        "description": "Alert once per visit when a visitor remains inside after their approved access window ends.",
        "category": "presence_anomaly",
        "severity": "medium",
        "enabled": True,
        "scope": "Visitors",
        "conditionKey": "visitor_overstay",
        "recentTriggers": 0,
    },
    {
        "id": "rule-scan-burst",
        "name": "High scan volume",
        "description": "Alert when 10 or more scan attempts are recorded at one checkpoint within 60 seconds.",
        "category": "operational",
        "severity": "high",
        "enabled": True,
        "scope": "All checkpoints",
        "conditionKey": "scan_burst",
        "recentTriggers": 0,
    },
    {
        "id": "rule-checkpoint-denial-rate",
        "name": "Unusually high denial rate",
        "description": "Alert when at least 10 scan attempts in 15 minutes have a denial rate of at least 50% and twice the checkpoint's prior rate. The baseline needs 20 or more of up to 100 prior scans from the last 7 days.",
        "category": "operational",
        "severity": "high",
        "enabled": True,
        "scope": "All checkpoints",
        "conditionKey": "checkpoint_denial_rate",
        "recentTriggers": 0,
    },
    {
        "id": "rule-checkpoint-offline",
        "name": "Checkpoint terminal offline",
        "description": f"Alert when no terminal assigned to a checkpoint has sent a heartbeat for {CHECKPOINT_HEARTBEAT_TIMEOUT_MINUTES} minutes. Resolve the alert automatically when a terminal reconnects.",
        "category": "operational",
        "severity": "high",
        "enabled": True,
        "scope": "Assigned checkpoints",
        "conditionKey": "checkpoint_offline",
        "recentTriggers": 0,
    },
]


def default_alert_rules() -> list[dict[str, object]]:
    return [dict(rule) for rule in DEFAULT_ALERT_RULES]


def is_retired_alert(raw: dict[str, Any]) -> bool:
    """Return True for alerts/rules retired from the product contract."""
    rule_id = str(raw.get("ruleId") or raw.get("id") or "")
    condition = str(raw.get("conditionKey") or "")
    title = str(raw.get("title") or raw.get("name") or "").strip().lower()
    return (
        rule_id in RETIRED_ALERT_RULE_IDS
        or condition in RETIRED_ALERT_CONDITIONS
        or title in {
            "exit balance anomaly",
            "exit count exceeds entry count",
            "restricted employee entry",
            "restricted employee entry attempt",
            "unauthorized hardware carrier",
            "access decision denied",
        }
    )


def eligible_alert_subject_types(rule: dict[str, Any]) -> tuple[str, ...]:
    """Return applicability for implemented, nonretired rules."""
    if is_retired_alert(rule):
        return ()
    if rule.get("conditionKey") in ("no_break", "irregularity"):
        return ("employee",)
    if rule.get("conditionKey") == "cross_building_scan":
        return ("employee", "visitor")
    if rule.get("conditionKey") == "visitor_overstay":
        return ("visitor",)
    return ()


def is_system_alert_rule(rule: dict[str, Any]) -> bool:
    """True for global rules evaluated from application events, not subjects."""
    condition = rule.get("conditionKey")
    return isinstance(condition, str) and condition in SYSTEM_ALERT_CONDITIONS


def with_default_alert_rules(rules: list[AlertRule]) -> list[AlertRule]:
    """Keep older databases usable when they predate one of the built-in rules."""
    # Manual reviews and unknown barcodes are not alert rules. Strip legacy
    # rows if they exist in an older database before returning rules to either
    # the UI or the scheduled evaluator.
    result = [
        dict(rule)
        for rule in rules
        if rule.get("conditionKey") not in {"manual_review", "unknown_barcode"}
        and rule.get("id") not in {"rule-manual-review", "rule-unknown-barcode"}
        and not is_retired_alert(rule)
    ]
    current_rule_display = {
        rule["conditionKey"]: rule
        for rule in DEFAULT_ALERT_RULES
        if rule.get("conditionKey") in {"no_break", "visitor_overstay"}
    }
    # Keep this persisted condition key and rule ID stable for existing
    # databases, while canonicalizing the copy shown in the UI to the current
    # visitor-permission-expiry behavior.
    for rule in result:
        display_rule = current_rule_display.get(rule.get("conditionKey"))
        if display_rule:
            for field in ("name", "description", "scope"):
                rule[field] = display_rule[field]
    existing_conditions = {rule.get("conditionKey") for rule in result}
    result.extend(
        dict(rule)
        for rule in DEFAULT_ALERT_RULES
        if rule.get("conditionKey") not in existing_conditions
    )
    return result


class MovementEvent(TypedDict, total=False):
    id: str
    date: str
    time: str
    checkpointId: str
    checkpoint: str
    direction: Direction
    subjectId: str
    subjectName: str
    subjectType: SubjectType
    barcode: str
    result: ResultStatus
    reason: str
    denialCode: str
    scanType: Literal["auto", "manual"]
    syncState: SyncState
    hardwareIds: list[str]
    createdAt: str


class Person(TypedDict, total=False):
    id: str
    name: str
    type: Literal["employee", "visitor"]
    barcode: str
    company: str
    phone: str
    allowedZones: list[str]
    status: Literal["active", "inactive", "pre_approved", "pending_approval", "restricted", "expired"]
    host: str
    purpose: str
    validFrom: str
    validTo: str
    inside: bool
    createdAt: str


class Alert(TypedDict, total=False):
    id: str
    severity: AlertSeverity
    status: AlertStatus
    title: str
    reason: str
    subjectName: str
    barcode: str
    checkpoint: str
    date: str
    time: str
    category: AlertCategory
    ruleId: str
    explanation: str
    sourceEventId: str
    subjectId: str
    subjectType: SubjectType
    entryStartedAt: str
    entryBuildingId: str | None
    conditionKey: ConditionKey
    createdAt: str
    permissionValidTo: str
    intervalIndex: int


class AlertRule(TypedDict, total=False):
    id: str
    name: str
    description: str
    category: AlertCategory
    severity: AlertSeverity
    enabled: bool
    scope: str
    conditionKey: ConditionKey
    recentTriggers: int


class WorkdayStatus(TypedDict):
    employeeId: str
    employeeName: str
    date: str
    breakMinutes: int
    minutesInside: int
    shiftEnded: bool


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _movement_timestamp(movement: MovementEvent) -> float:
    """Normalize a movement timestamp for scheduled rule evaluation.

    Prefer the explicit ISO timestamp, then fall back to legacy date/time
    fields. Return zero when neither representation can be parsed.
    """
    created_at = movement.get("createdAt")
    if created_at:
        try:
            # Handle both trailing-Z and +offset ISO strings
            ts = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            ms = ts.timestamp() * 1_000
            if ms == ms:  # isFinite equivalent
                return ms
        except (ValueError, TypeError):
            pass

    date_str = movement.get("date", "")
    time_str = movement.get("time", "")
    if date_str and time_str:
        combined = f"{date_str} {time_str}"
        # Try several formats produced by the TS locale formatter
        for fmt in (
            "%b %d, %Y %I:%M:%S %p",   # "Sep 08, 2026 01:44:38 PM"
            "%b %d, %Y %I:%M %p",       # "Sep 08, 2026 01:44 PM"
            "%b %-d, %Y %I:%M:%S %p",   # Linux: no zero-pad for day
            "%b %d, %Y %H:%M:%S",       # fallback 24-h
        ):
            try:
                ts = datetime.strptime(combined, fmt)
                return ts.timestamp() * 1_000
            except ValueError:
                continue

    return 0.0


def _highest_alert_suffix(existing_alerts: list[Alert]) -> int:
    """Find the largest numeric suffix already used by a stored alert."""
    highest = 0
    for alert in existing_alerts:
        m = re.search(r"(\d+)$", alert.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return highest


def _find_enabled_rule(
    rules: list[AlertRule], condition_key: ConditionKey,
    subject_id: str | None = None, rule_assignments: dict[str, list[str]] | None = None,
) -> AlertRule | None:
    """Find an enabled matching rule within a subject's complete selection."""
    for rule in rules:
        if (rule.get("conditionKey") == condition_key and rule.get("enabled")
                and eligible_alert_subject_types(rule)
                and (subject_id is None or rule_assignments is None
                     or subject_id not in rule_assignments or rule.get("id") in rule_assignments[subject_id])):
            return rule
    return None


def _local_date(dt: datetime) -> str:
    local = dt.astimezone(_IST)
    return f"{local.strftime('%b')} {local.day}, {local.year}"


def _local_time(dt: datetime) -> str:
    local = dt.astimezone(_IST)
    hour = local.hour % 12 or 12
    suffix = "AM" if local.hour < 12 else "PM"
    return f"{hour}:{local.minute:02d}:{local.second:02d} {suffix}"


def _permission_expiry(value: Any) -> datetime | None:
    """Parse a visitor permission's expiry, treating naive values as facility time."""
    if not isinstance(value, str) or not value:
        return None
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=_IST)
    return expiry.astimezone(timezone.utc)


def evaluate_visitor_permission_overstay_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
    rule_assignments: dict[str, list[str]] | None = None,
) -> list[Alert]:
    """Alert once per visit when a visitor remains inside after permission expiry."""
    rule = _find_enabled_rule(rules, "visitor_overstay")
    if rule is None:
        return []
    evaluation_now = now or datetime.now(timezone.utc)
    generated = []
    for visit in visits:
        started_at = visit.get("entryStartedAt")
        subject_type = visit.get("subjectType")
        valid_to = _permission_expiry(visit.get("permissionValidTo"))
        alerted_valid_to = visit.get("alertedPermissionValidTo")
        if isinstance(alerted_valid_to, datetime):
            if alerted_valid_to.tzinfo is None:
                alerted_valid_to = alerted_valid_to.replace(tzinfo=_IST)
            alerted_valid_to = alerted_valid_to.astimezone(timezone.utc)
        if (subject_type != "visitor" or visit.get("state") != "inside"
                or not visit.get("subjectId") or not isinstance(started_at, datetime)
                or started_at.tzinfo is None or evaluation_now < started_at.astimezone(timezone.utc)
                or valid_to is None or evaluation_now < valid_to
                or alerted_valid_to == valid_to):
            continue
        start_utc = started_at.astimezone(timezone.utc).isoformat()
        valid_to_utc = valid_to.isoformat()
        identity = uuid.uuid5(uuid.NAMESPACE_URL,
            f"in-out:visitor-permission-overstay:{visit['subjectId']}:{start_utc}:{valid_to_utc}")
        building = visit.get("buildingName") or visit.get("buildingId") or "an unrecorded zone"
        name = visit.get("subjectName") or visit.get("barcode") or visit["subjectId"]
        generated.append(Alert(
            id=f"AL-{identity.hex.upper()}", severity=rule.get("severity", "medium"),
            status="open", title="Visitor permission overstay",
            reason=f"{name} remained inside {building} after their approved access expired at "
                f"{_local_date(valid_to)} {_local_time(valid_to)}.",
            subjectName=name, subjectId=visit["subjectId"], subjectType=subject_type,
            barcode=visit.get("barcode") or visit["subjectId"], checkpoint=building,
            date=_local_date(evaluation_now), time=_local_time(evaluation_now),
            category=rule.get("category", "presence_anomaly"), ruleId=rule.get("id"),
            conditionKey="visitor_overstay", entryStartedAt=start_utc,
            permissionValidTo=valid_to_utc,
            entryBuildingId=visit.get("buildingId"),
            explanation=f"The visitor's approved access window ended at {valid_to_utc}; "
                f"the current visit began at {start_utc} and has no approved exit.",
        ))
    return generated


def evaluate_visitor_overstay_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
) -> list[Alert]:
    """Compatibility name for the visitor-permission-expiry evaluator."""
    return evaluate_visitor_permission_overstay_rules(
        rules, visits, now=now,
    )


def evaluate_no_break_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
    rule_assignments: dict[str, list[str]] | None = None,
) -> list[Alert]:
    """Maintain one alert case per continuous visit, refreshing it at six-hour boundaries."""
    evaluation_now = now or datetime.now(timezone.utc)
    generated: list[Alert] = []
    for visit in visits:
        started_at = visit.get("entryStartedAt")
        subject_id = visit.get("subjectId")
        if (visit.get("subjectType") != "employee" or visit.get("state") != "inside"
                or not subject_id or not isinstance(started_at, datetime) or started_at.tzinfo is None):
            continue
        rule = _find_enabled_rule(rules, "no_break", subject_id, rule_assignments)
        if rule is None:
            continue
        elapsed_seconds = (evaluation_now - started_at.astimezone(timezone.utc)).total_seconds()
        due_interval = int(elapsed_seconds // (6 * 60 * 60)) if elapsed_seconds >= 0 else 0
        try:
            last_alerted_interval = max(0, int(visit.get("noBreakAlertedInterval") or 0))
        except (TypeError, ValueError):
            last_alerted_interval = 0
        if due_interval <= last_alerted_interval:
            continue

        start_utc = started_at.astimezone(timezone.utc).isoformat()
        building = visit.get("buildingName") or visit.get("buildingId") or "an unrecorded zone"
        name = visit.get("subjectName") or visit.get("barcode") or subject_id
        threshold_at = started_at + timedelta(hours=6)
        identity = uuid.uuid5(uuid.NAMESPACE_URL, f"in-out:no-break:{subject_id}:{start_utc}")
        generated.append(Alert(
            id=f"AL-{identity.hex.upper()}",
            severity=("critical" if rule.get("severity") == "critical" else
                "high" if due_interval >= 2 else rule.get("severity", "medium")),
            status="open", title="Continuous presence",
            reason=(f"{name} has remained inside {building} without an approved exit for "
                    f"at least {6 * due_interval} hours."),
            subjectName=name, subjectId=subject_id, subjectType="employee",
            barcode=visit.get("barcode") or subject_id, checkpoint=building,
            date=_local_date(threshold_at), time=_local_time(threshold_at),
            category=rule.get("category", "operational"), ruleId=rule.get("id"),
            conditionKey="no_break", entryStartedAt=start_utc,
            entryBuildingId=visit.get("buildingId"), intervalIndex=due_interval,
            reminderCount=max(0, due_interval - 1),
            explanation=("One alert case is kept for this visit. Each later six-hour check updates the case "
                "instead of adding another warning; an approved exit starts a new case."),
        ))
    return generated


def evaluate_continuous_presence_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
    rule_assignments: dict[str, list[str]] | None = None,
) -> list[Alert]:
    """Evaluate employee no-break intervals and visitor access-window overstays."""
    return [
        *evaluate_no_break_rules(rules, visits, now=now, rule_assignments=rule_assignments),
        *evaluate_visitor_permission_overstay_rules(rules, visits, now=now, rule_assignments=rule_assignments),
    ]


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

def build_workday_statuses(
    movements: list[MovementEvent],
    people: list[Person],
    now: datetime | None = None,
) -> list[WorkdayStatus]:
    """
    Compute per-employee-per-day work summaries from movement events.
    Port of buildWorkdayStatuses() in ruleEngine.ts.

    Only approved employee movements are considered.
    Calculates total minutes inside, break minutes (gap between exit and
    re-entry), and whether the shift ended with a final exit. An employee
    who is still inside is included using the current time, so scheduled
    rules can detect a six-hour continuous shift before the exit is scanned.
    """
    evaluation_now = now or datetime.now(timezone.utc)
    evaluation_timestamp = evaluation_now.timestamp() * 1_000
    evaluation_date = _local_date(evaluation_now)

    # Build employee lookup (id -> Person) — employees only
    employee_by_id: dict[str, Person] = {
        p["id"]: p
        for p in people
        if p.get("id") and (p.get("type") or p.get("kind")) == "employee"
    }

    # Group events by (subjectId, date)
    events_by_employee_day: dict[str, list[MovementEvent]] = {}
    for movement in movements:
        if (
            movement.get("result") != "approved"
            or movement.get("subjectType") != "employee"
            or movement.get("subjectId") not in employee_by_id
        ):
            continue
        key = f"{movement['subjectId']}\x00{movement['date']}"
        events_by_employee_day.setdefault(key, []).append(movement)

    workdays: list[WorkdayStatus] = []
    for key, events in events_by_employee_day.items():
        employee_id, date = key.split("\x00", 1)
        employee = employee_by_id.get(employee_id)
        if not employee:
            continue

        # Parse each timestamp once. The old key function parsed every event
        # for sorting and then parsed it again while pairing entries/exits.
        timed_events = [(_movement_timestamp(event), event) for event in events]
        timed_events.sort(key=lambda item: item[0])

        entry_at: float | None = None
        last_exit_at: float | None = None
        minutes_inside: float = 0.0
        break_minutes: float = 0.0
        shift_ended: bool = False

        for occurred_at, event in timed_events:
            if event.get("direction") == "entry" and entry_at is None:
                # Count break gap between previous exit and this re-entry
                if last_exit_at is not None and occurred_at > last_exit_at:
                    break_minutes += (occurred_at - last_exit_at) / 60_000
                entry_at = occurred_at
                shift_ended = False
            elif (
                event.get("direction") == "exit"
                and entry_at is not None
                and occurred_at > entry_at
            ):
                minutes_inside += (occurred_at - entry_at) / 60_000
                entry_at = None
                last_exit_at = occurred_at
                shift_ended = True

        # An open entry is real working time, not an incomplete workday to
        # discard. Only extend today's open shift; historical unmatched
        # entries cannot be safely attributed to the current time.
        if entry_at is not None and date == evaluation_date and evaluation_timestamp > entry_at:
            minutes_inside += (evaluation_timestamp - entry_at) / 60_000

        workdays.append(
            WorkdayStatus(
                employeeId=employee_id,
                employeeName=employee.get("name", ""),
                date=date,
                breakMinutes=round(break_minutes),
                minutesInside=round(minutes_inside),
                shiftEnded=shift_ended,
            )
        )

    return workdays


def evaluate_scheduled_rules(
    rules: list[AlertRule],
    movements: list[MovementEvent],
    workdays: list[WorkdayStatus],
    existing_alerts: list[Alert],
    employees: list[Person] | None = None,
    now: datetime | None = None,
    rule_assignments: dict[str, list[str]] | None = None,
    irregularity_skip_dates: dict[str, list[str]] | None = None,
    attendance_workdays: tuple[int, ...] = (0, 1, 2, 3, 4),
    attendance_cutoff_hour: int = 18,
    attendance_cutoff_minute: int = 0,
    attendance_grace_minutes: int = 60,
    attendance_holidays: set[str] | None = None,
) -> list[Alert]:
    """
    Evaluate time-based / scheduled alert rules and return new Alert dicts.
    Port of evaluateScheduledRules() in ruleEngine.ts.

    Rules evaluated
    ---------------
    irregularity          : active employee has no approved entry by 6 PM (Asia/Kolkata)

    The workdays argument is retained for compatibility, but no-break alerts
    are evaluated from uninterrupted current presence, independent of dates.

    Missing assignment entries inherit all eligible rules. A present empty
    list disables all rules for that subject without affecting other subjects.
    Irregularity skip dates suppress only that employee's attendance check on
    the matching Asia/Kolkata calendar date.
    """
    generated: list[Alert] = []

    # Rules are stable for one evaluation. Prepare lookups once instead of
    # scanning the full catalog for every employee and workday.
    rules_by_condition: dict[str, list[AlertRule]] = {}
    for rule in rules:
        condition = rule.get("conditionKey")
        if (isinstance(condition, str) and rule.get("enabled")
                and eligible_alert_subject_types(rule)):
            rules_by_condition.setdefault(condition, []).append(rule)
    assignment_sets = {
        subject_id: set(rule_ids)
        for subject_id, rule_ids in (rule_assignments or {}).items()
    }

    def selected_rule(condition: str, subject_id: str | None = None) -> AlertRule | None:
        candidates = rules_by_condition.get(condition, ())
        if subject_id is None or rule_assignments is None or subject_id not in assignment_sets:
            return candidates[0] if candidates else None
        selected = assignment_sets[subject_id]
        return next((rule for rule in candidates if rule.get("id") in selected), None)

    # Preserve the legacy ID sequence while scanning stored IDs only once.
    next_alert_number = _highest_alert_suffix(existing_alerts) + 1

    def next_alert_id() -> str:
        nonlocal next_alert_number
        value = f"AL-2026-{str(next_alert_number).zfill(4)}"
        next_alert_number += 1
        return value

    # Alert de-duplication used to scan the full history for each person/day.
    # These keys express the same identity rules with constant-time lookups.
    irregularity_keys = {
        (alert.get("ruleId"), alert.get("barcode"), alert.get("date"))
        for alert in existing_alerts
    }
    evaluation_now = now or datetime.now(timezone.utc)
    # ------------------------------------------------------------------
    # irregularity rule
    # ------------------------------------------------------------------
    irregularity_rule = selected_rule("irregularity")
    local_now = evaluation_now.astimezone(_IST)
    today = _local_date(evaluation_now)
    cutoff = local_now.replace(hour=attendance_cutoff_hour, minute=attendance_cutoff_minute,
        second=0, microsecond=0) + timedelta(minutes=attendance_grace_minutes)
    attendance_day = local_now.date().isoformat()
    if (irregularity_rule and local_now.weekday() in attendance_workdays
            and attendance_day not in (attendance_holidays or set()) and local_now >= cutoff):
        employee_roster = employees or []
        entry_times: dict[str, datetime | None] = {}
        entered_today = set()
        for event in movements:
            if not (
                event.get("result") == "approved"
                and event.get("direction") == "entry"
                and event.get("subjectType") == "employee"
                and event.get("date") == today
                and event.get("subjectId")
            ):
                continue
            employee_id = event["subjectId"]
            raw_timestamp = event.get("createdAt")
            try:
                entry_at = datetime.fromisoformat(str(raw_timestamp).replace("Z", "+00:00"))
                if entry_at.tzinfo is None:
                    entry_at = entry_at.replace(tzinfo=_IST)
                entry_at = entry_at.astimezone(_IST)
            except (TypeError, ValueError):
                entry_at = None
            entered_today.add(employee_id)
            if employee_id not in entry_times or (entry_at is not None and
                    (entry_times[employee_id] is None or entry_at < entry_times[employee_id])):
                entry_times[employee_id] = entry_at
        for employee in employee_roster:
            employee_id = employee.get("id", "")
            status = employee.get("status", "active")
            if (
                not employee_id
                or (employee.get("type") or employee.get("kind")) != "employee"
                or status in {"inactive", "restricted", "expired"}
                or (employee_id in entered_today and
                    (entry_times.get(employee_id) is None or entry_times[employee_id] <= cutoff))
            ):
                continue
            if local_now.date().isoformat() in (irregularity_skip_dates or {}).get(employee_id, []):
                continue
            employee_rule = selected_rule("irregularity", employee_id)
            if employee_rule is None:
                continue
            barcode = employee.get("barcode") or employee_id
            duplicate_key = (employee_rule.get("id"), barcode, today)
            if duplicate_key in irregularity_keys:
                continue
            generated.append(
                Alert(
                    id=next_alert_id(),
                    severity=employee_rule.get("severity", "medium"),
                    status="open",
                    title="Attendance irregularity",
                    reason=(f"{employee.get('name', employee_id)} recorded their first entry after the attendance cutoff."
                        if employee_id in entered_today else
                        f"{employee.get('name', employee_id)} has no approved entry by the attendance cutoff."),
                    subjectName=employee.get("name", employee_id),
                    barcode=employee.get("barcode") or employee_id,
                    checkpoint="Attendance policy",
                    date=today,
                    time=_local_time(evaluation_now),
                    category=employee_rule.get("category", "presence_anomaly"),
                    ruleId=employee_rule.get("id"),
                    conditionKey="irregularity",
                    subjectId=employee_id,
                    explanation=(f"The attendance cutoff is {attendance_cutoff_hour:02d}:{attendance_cutoff_minute:02d} "
                        f"plus {attendance_grace_minutes} minutes of grace on configured workdays."),
                )
            )
            irregularity_keys.add(duplicate_key)

    return generated
