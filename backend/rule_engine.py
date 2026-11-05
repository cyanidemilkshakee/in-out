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
]

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
_ATTENDANCE_CUTOFF_HOUR = 18

DEFAULT_ALERT_RULES: list[dict[str, object]] = [
    {
        "id": "rule-no-break",
        "name": "No break recorded",
        "description": "Alert when an employee works six hours without a break.",
        "category": "operational",
        "severity": "medium",
        "enabled": True,
        "scope": "Employee workdays",
        "conditionKey": "no_break",
        "recentTriggers": 0,
    },
    {
        "id": "rule-irregularity",
        "name": "Irregularity",
        "description": "Alert when an active employee has no approved entry by the end of the day.",
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
        "name": "Continuous presence over 12 hours",
        "description": "Alert once per visit when an employee or visitor remains inside a zone for more than 12 continuous hours.",
        "category": "presence_anomaly",
        "severity": "medium",
        "enabled": True,
        "scope": "Employees and visitors",
        "conditionKey": "visitor_overstay",
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
        return ("employee", "visitor")
    return ()


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
    # This persisted condition key predates employee coverage. Canonicalize
    # its display copy so existing databases show the expanded rule scope.
    continuous_presence = next(rule for rule in DEFAULT_ALERT_RULES
        if rule.get("conditionKey") == "visitor_overstay")
    for rule in result:
        if rule.get("conditionKey") == "visitor_overstay":
            for field in ("name", "description", "scope"):
                rule[field] = continuous_presence[field]
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


def evaluate_continuous_presence_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
) -> list[Alert]:
    """Alert once when an employee or visitor remains inside for over 12 hours."""
    rule = _find_enabled_rule(rules, "visitor_overstay")
    if rule is None:
        return []
    evaluation_now = now or datetime.now(timezone.utc)
    generated = []
    for visit in visits:
        started_at = visit.get("entryStartedAt")
        subject_type = visit.get("subjectType")
        if (subject_type not in {"employee", "visitor"} or visit.get("state") != "inside"
                or not visit.get("subjectId") or not isinstance(started_at, datetime)
                or started_at.tzinfo is None
                or evaluation_now - started_at <= timedelta(hours=12)
                or visit.get("alertedEntryAt") == started_at):
            continue
        start_utc = started_at.astimezone(timezone.utc).isoformat()
        identity_scope = "visitor-overstay" if subject_type == "visitor" else "employee-overstay"
        identity = uuid.uuid5(uuid.NAMESPACE_URL, f"in-out:{identity_scope}:{visit['subjectId']}:{start_utc}")
        building = visit.get("buildingName") or visit.get("buildingId") or "an unrecorded zone"
        name = visit.get("subjectName") or visit.get("barcode") or visit["subjectId"]
        generated.append(Alert(
            id=f"AL-{identity.hex.upper()}", severity=rule.get("severity", "medium"),
            status="open", title="Continuous presence over 12 hours",
            reason=f"{name} has remained inside {building} for more than 12 continuous hours.",
            subjectName=name, subjectId=visit["subjectId"], subjectType=subject_type,
            barcode=visit.get("barcode") or visit["subjectId"], checkpoint=building,
            date=_local_date(evaluation_now), time=_local_time(evaluation_now),
            category=rule.get("category", "presence_anomaly"), ruleId=rule.get("id"),
            conditionKey="visitor_overstay", entryStartedAt=start_utc,
            entryBuildingId=visit.get("buildingId"),
            explanation=f"The current visit began at {start_utc}; no approved exit has ended it. Repeated scans do not restart the visit clock.",
        ))
    return generated


def evaluate_visitor_overstay_rules(
    rules: list[AlertRule], visits: list[dict[str, Any]], now: datetime | None = None,
) -> list[Alert]:
    """Compatibility wrapper for callers that specifically evaluate visitors."""
    return evaluate_continuous_presence_rules(
        rules, [visit for visit in visits if visit.get("subjectType") == "visitor"], now=now,
    )


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
) -> list[Alert]:
    """
    Evaluate time-based / scheduled alert rules and return new Alert dicts.
    Port of evaluateScheduledRules() in ruleEngine.ts.

    Rules evaluated
    ---------------
    no_break              : employee worked >= 6 hours without any break
    irregularity          : active employee has no approved entry by 6 PM (Asia/Kolkata)

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
    no_break_subject_keys = {
        (alert.get("ruleId"), alert.get("subjectId"), alert.get("date"))
        for alert in existing_alerts if alert.get("subjectId")
    }
    no_break_legacy_keys = {
        (alert.get("ruleId"), alert.get("barcode"), alert.get("date"))
        for alert in existing_alerts if not alert.get("subjectId")
    }

    evaluation_now = now or datetime.now(timezone.utc)
    # ------------------------------------------------------------------
    # irregularity rule
    # ------------------------------------------------------------------
    irregularity_rule = selected_rule("irregularity")
    local_now = evaluation_now.astimezone(_IST)
    today = _local_date(evaluation_now)
    if irregularity_rule and local_now.hour >= _ATTENDANCE_CUTOFF_HOUR:
        employee_roster = employees or []
        entered_today = {
            event.get("subjectId")
            for event in movements
            if event.get("result") == "approved"
            and event.get("direction") == "entry"
            and event.get("subjectType") == "employee"
            and event.get("date") == today
        }
        for employee in employee_roster:
            employee_id = employee.get("id", "")
            status = employee.get("status", "active")
            if (
                not employee_id
                or (employee.get("type") or employee.get("kind")) != "employee"
                or status in {"inactive", "restricted", "expired"}
                or employee_id in entered_today
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
                    reason=(
                        f"{employee.get('name', employee_id)} is listed as an active "
                        "employee but has no approved entry today."
                    ),
                    subjectName=employee.get("name", employee_id),
                    barcode=employee.get("barcode") or employee_id,
                    checkpoint="Attendance policy",
                    date=today,
                    time=_local_time(evaluation_now),
                    category=employee_rule.get("category", "presence_anomaly"),
                    ruleId=employee_rule.get("id"),
                    conditionKey="irregularity",
                    subjectId=employee_id,
                    explanation="No approved employee entry was recorded before the 6:00 PM attendance cutoff.",
                )
            )
            irregularity_keys.add(duplicate_key)

    # ------------------------------------------------------------------
    # no_break rule
    # ------------------------------------------------------------------
    break_rule = selected_rule("no_break")
    if break_rule:
        employee_by_id = {employee.get("id"): employee for employee in employees or []}
        for workday in workdays:
            workday_rule = selected_rule("no_break", workday["employeeId"])
            if workday_rule is None:
                continue
            employee_barcode = employee_by_id.get(workday["employeeId"], {}).get("barcode") or workday["employeeId"]
            rule_id = workday_rule.get("id")
            employee_id = workday["employeeId"]
            workday_date = workday["date"]
            already_raised = (
                (rule_id, employee_id, workday_date) in no_break_subject_keys
                or (rule_id, employee_barcode, workday_date) in no_break_legacy_keys
                or (rule_id, employee_id, workday_date) in no_break_legacy_keys
            )
            if (
                workday["breakMinutes"] > 0
                or workday["minutesInside"] < 360
                or already_raised
            ):
                continue
            hours_worked = round(workday["minutesInside"] / 60)
            generated.append(
                Alert(
                    id=next_alert_id(),
                    severity=workday_rule.get("severity", "medium"),
                    status="open",
                    title="No break recorded",
                    reason=(
                        f"{workday['employeeName']} completed {hours_worked} "
                        f"hours without a recorded break."
                    ),
                    subjectName=workday["employeeName"],
                    barcode=employee_barcode,
                    checkpoint="Attendance policy",
                    date=workday["date"],
                    time=(
                        _local_time(evaluation_now)
                        if workday["date"] == _local_date(evaluation_now)
                        else "6:00:00 PM"
                    ),
                    category=workday_rule.get("category", "operational"),
                    ruleId=workday_rule.get("id"),
                    conditionKey="no_break",
                    subjectId=workday["employeeId"],
                    explanation="At least six hours of approved work were recorded without a qualifying break.",
                )
            )

    return generated
