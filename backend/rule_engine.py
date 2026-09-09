"""
rule_engine.py
--------------
Python port of lib/ruleEngine.ts.

Public API
----------
build_workday_statuses(movements, people) -> list[dict]
evaluate_scheduled_rules(rules, movements, workdays, existing_alerts) -> list[dict]
create_scan_alert(event, subject, carried_hardware, rules, existing_alerts, alert_id) -> dict | None
"""

from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta
from typing import Any, Literal, Optional, TypedDict

# ---------------------------------------------------------------------------
# TypedDicts (mirror of types.ts — minimal subset needed here)
# ---------------------------------------------------------------------------

Direction = Literal["entry", "exit"]
ResultStatus = Literal["approved", "denied"]
SyncState = Literal["synced", "queued", "conflict"]
SubjectType = Literal["employee", "visitor", "hardware"]

AlertSeverity = Literal["critical", "high", "medium"]
AlertStatus = Literal["open", "acknowledged", "resolved"]
AlertCategory = Literal["access_violation", "presence_anomaly", "hardware_custody", "operational"]
ConditionKey = Literal[
    "exit_balance",
    "no_break",
    "unauthorized_hardware_carrier",
    "restricted_employee_entry",
]


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
    department: str
    company: str
    phone: str
    accessLevel: str
    allowedZones: list[str]
    status: Literal["active", "inactive", "pre_approved", "pending_approval", "restricted", "expired"]
    host: str
    purpose: str
    validFrom: str
    validTo: str
    inside: bool
    createdAt: str


class HardwareAsset(TypedDict, total=False):
    id: str
    name: str
    barcode: str
    owner: str
    assignedEmployeeId: str
    assignedEmployeeName: str
    category: str
    allowedZones: list[str]
    status: Literal["active", "restricted", "maintenance"]
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
    rules: list[AlertRule], condition_key: ConditionKey
) -> AlertRule | None:
    """Return the first enabled rule matching condition_key."""
    for rule in rules:
        if rule.get("conditionKey") == condition_key and rule.get("enabled"):
            return rule
    return None


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

def build_workday_statuses(
    movements: list[MovementEvent],
    people: list[Person],
) -> list[WorkdayStatus]:
    """
    Compute per-employee-per-day work summaries from movement events.
    Port of buildWorkdayStatuses() in ruleEngine.ts.

    Only approved employee movements are considered.
    Calculates total minutes inside, break minutes (gap between exit and
    re-entry), and whether the shift ended with a final exit.
    """
    # Build employee lookup (id -> Person) — employees only
    employee_by_id: dict[str, Person] = {
        p["id"]: p
        for p in people
        if p.get("type") == "employee"
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
) -> list[Alert]:
    """
    Evaluate time-based / scheduled alert rules and return new Alert dicts.
    Port of evaluateScheduledRules() in ruleEngine.ts.

    Rules evaluated
    ---------------
    exit_balance          : daily exit count > entry count
    no_break              : employee worked >= 6 hours without any break
    """
    generated: list[Alert] = []

    # ------------------------------------------------------------------
    # exit_balance rule
    # ------------------------------------------------------------------
    exit_rule = _find_enabled_rule(rules, "exit_balance")
    if exit_rule:
        totals_by_date: dict[str, dict[str, int]] = {}
        for event in movements:
            if event.get("result") != "approved":
                continue
            date = event.get("date", "")
            if date not in totals_by_date:
                totals_by_date[date] = {"entries": 0, "exits": 0}
            if event.get("direction") == "entry":
                totals_by_date[date]["entries"] += 1
            if event.get("direction") == "exit":
                totals_by_date[date]["exits"] += 1

        for date, totals in totals_by_date.items():
            already_raised = any(
                a.get("ruleId") == exit_rule.get("id") and a.get("date") == date
                for a in existing_alerts
            )
            if totals["exits"] <= totals["entries"] or already_raised:
                continue
            generated.append(
                Alert(
                    id=_next_alert_id([*existing_alerts, *generated]),
                    severity=exit_rule.get("severity", "medium"),
                    status="open",
                    title="Exit count exceeds entry count",
                    reason=(
                        f"{totals['exits']} exits were recorded against "
                        f"{totals['entries']} entries."
                    ),
                    subjectName="Facility occupancy",
                    barcode="SYSTEM",
                    checkpoint="All checkpoints",
                    date=date,
                    time="6:05:00 PM",
                    category=exit_rule.get("category", "operational"),
                    ruleId=exit_rule.get("id"),
                    explanation=(
                        "Daily approved exit count is greater than the "
                        "approved entry count."
                    ),
                )
            )

    # ------------------------------------------------------------------
    # no_break rule
    # ------------------------------------------------------------------
    break_rule = _find_enabled_rule(rules, "no_break")
    if break_rule:
        for workday in workdays:
            already_raised = any(
                a.get("ruleId") == break_rule.get("id")
                and a.get("subjectName") == workday["employeeName"]
                and a.get("date") == workday["date"]
                for a in existing_alerts
            )
            if (
                not workday["shiftEnded"]
                or workday["breakMinutes"] > 0
                or workday["minutesInside"] < 360
                or already_raised
            ):
                continue
            hours_worked = round(workday["minutesInside"] / 60)
            generated.append(
                Alert(
                    id=_next_alert_id([*existing_alerts, *generated]),
                    severity=break_rule.get("severity", "medium"),
                    status="open",
                    title="No break recorded by end of day",
                    reason=(
                        f"{workday['employeeName']} completed {hours_worked} "
                        f"hours without a recorded break."
                    ),
                    subjectName=workday["employeeName"],
                    barcode=workday["employeeId"],
                    checkpoint="Attendance policy",
                    date=workday["date"],
                    time="6:00:00 PM",
                    category=break_rule.get("category", "operational"),
                    ruleId=break_rule.get("id"),
                    explanation="Shift ended with zero qualifying break minutes.",
                )
            )

    return generated


def create_scan_alert(
    event: MovementEvent,
    subject: Any | None,
    carried_hardware: list[HardwareAsset],
    rules: list[AlertRule],
    existing_alerts: list[Alert],
    alert_id: str | None = None,
) -> Alert | None:
    """
    Optionally create an alert for a denied scan event.
    Port of createScanAlert() in ruleEngine.ts.

    Returns an Alert dict when the denial matches an enabled rule (or is a
    visitor-pending denial), otherwise returns None.

    Parameters
    ----------
    event            : the MovementEvent that was denied
    subject          : the resolved Person or HardwareAsset (may be None)
    carried_hardware : hardware assets carried during the scan
    rules            : all configured AlertRules
    existing_alerts  : alerts already in the system (dedup check)
    alert_id         : optional override for the generated alert ID
    """
    if event.get("result") != "denied":
        return None

    rule: AlertRule | None = None
    category: AlertCategory = "access_violation"
    title = "Access decision denied"

    reason = event.get("reason", "")

    if reason.startswith("Hardware assigned to"):
        rule = _find_enabled_rule(rules, "unauthorized_hardware_carrier")
        category = "hardware_custody"
        title = "Unauthorized hardware carrier"
    elif (
        subject is not None
        and "type" in subject
        and subject.get("type") == "employee"
        and subject.get("status") == "restricted"
    ):
        rule = _find_enabled_rule(rules, "restricted_employee_entry")
        category = "access_violation"
        title = "Restricted employee entry attempt"

    # No matching rule and not a visitor-pending denial → skip
    if rule is None and reason != "Temporary visitor approval pending":
        return None

    # Rule exists but is disabled → skip
    if rule is not None and not rule.get("enabled"):
        return None

    # Dedup: same source event or same open rule alert already exists
    event_id = event.get("id")
    rule_id = rule.get("id") if rule else None
    duplicate = any(
        a.get("sourceEventId") == event_id
        or (rule_id is not None and a.get("ruleId") == rule_id and a.get("status") == "open")
        for a in existing_alerts
    )
    if duplicate:
        return None

    hardware_names = ", ".join(a.get("name", "") for a in carried_hardware)
    now_iso = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{datetime.now(tz=timezone.utc).microsecond // 1000:03d}Z"
    )

    alert = Alert(
        id=alert_id if alert_id is not None else _next_alert_id(existing_alerts),
        severity=rule.get("severity", "medium") if rule else "medium",
        status="open",
        title=title,
        reason=reason or "Policy denied the movement.",
        subjectName=event.get("subjectName", ""),
        barcode=event.get("barcode", ""),
        checkpoint=event.get("checkpoint", ""),
        date=event.get("date", ""),
        time=event.get("time", ""),
        category=category,
        explanation=(
            f"Carrier and assigned custodian do not match for {hardware_names}."
            if hardware_names
            else "The access decision matched an enabled security rule."
        ),
    )

    if rule_id is not None:
        alert["ruleId"] = rule_id

    alert["sourceEventId"] = event_id

    # createdAt: prefer event's own createdAt, fall back to now
    alert["createdAt"] = event.get("createdAt") or now_iso

    return alert
