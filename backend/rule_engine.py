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
    """Only implemented, nonretired conditions can be assigned to subjects."""
    if rule.get("conditionKey") in ("no_break", "irregularity") and not is_retired_alert(rule):
        return ("employee",)
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
    """
    Convert a movement event to a UNIX millisecond timestamp.
    Port of movementTimestamp() in analyticsUtils.ts.

    Prefers `createdAt` (ISO-8601), falls back to parsing `date + time`
    as a locale-style string (e.g. "Sep 8, 2026 1:44:38 PM").
    Returns 0 when parsing fails — matching the TS behaviour of returning 0
    for non-finite values.
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


def _next_alert_id(existing_alerts: list[Alert], offset: int = 1) -> str:
    """
    Derive the next alert ID from the highest numeric suffix seen so far.
    Port of nextAlertId() in ruleEngine.ts.
    """
    highest = 0
    for alert in existing_alerts:
        m = re.search(r"(\d+)$", alert.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return f"AL-2026-{str(highest + offset).zfill(4)}"


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

        # Sort chronologically
        events.sort(key=_movement_timestamp)

        entry_at: float | None = None
        last_exit_at: float | None = None
        minutes_inside: float = 0.0
        break_minutes: float = 0.0
        shift_ended: bool = False

        for event in events:
            occurred_at = _movement_timestamp(event)
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

    evaluation_now = now or datetime.now(timezone.utc)
    # ------------------------------------------------------------------
    # irregularity rule
    # ------------------------------------------------------------------
    irregularity_rule = _find_enabled_rule(rules, "irregularity")
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
            employee_rule = _find_enabled_rule(rules, "irregularity", employee_id, rule_assignments)
            if employee_rule is None:
                continue
            already_raised = any(
                a.get("ruleId") == employee_rule.get("id")
                and a.get("barcode") == (employee.get("barcode") or employee_id)
                and a.get("date") == today
                for a in existing_alerts
            )
            already_generated = any(
                a.get("ruleId") == employee_rule.get("id")
                and a.get("barcode") == (employee.get("barcode") or employee_id)
                and a.get("date") == today
                for a in generated
            )
            if already_raised or already_generated:
                continue
            generated.append(
                Alert(
                    id=_next_alert_id([*existing_alerts, *generated]),
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

    # ------------------------------------------------------------------
    # no_break rule
    # ------------------------------------------------------------------
    break_rule = _find_enabled_rule(rules, "no_break")
    if break_rule:
        employee_by_id = {employee.get("id"): employee for employee in employees or []}
        for workday in workdays:
            workday_rule = _find_enabled_rule(rules, "no_break", workday["employeeId"], rule_assignments)
            if workday_rule is None:
                continue
            employee_barcode = employee_by_id.get(workday["employeeId"], {}).get("barcode") or workday["employeeId"]
            already_raised = any(
                a.get("ruleId") == workday_rule.get("id")
                and (
                    a.get("subjectId") == workday["employeeId"]
                    or (not a.get("subjectId") and a.get("barcode") in {employee_barcode, workday["employeeId"]})
                )
                and a.get("date") == workday["date"]
                for a in existing_alerts
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
                    id=_next_alert_id([*existing_alerts, *generated]),
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
