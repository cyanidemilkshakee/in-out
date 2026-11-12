"""Complete dashboard counters and employee activity; no sampled chart totals."""
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, or_, select, true, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_read_db
from config import settings
from data_limits import bounded_rows
from models import Alert, AlertReview, Checkpoint, Movement, PresenceState, Subject
from movement_history import canonical_movement_filter, movement_history
from zone_access import admin_zone_ids, checkpoint_zone_condition, subject_zone_condition

router = APIRouter()
RESTRICTED_DENIAL_CODES = (
    "asset_restricted", "access_restricted", "hardware_restricted",
    "zone_not_permitted", "cross_building_access", "expired_pass",
)
FACILITY_ZONE = ZoneInfo("Asia/Kolkata")


def denial_category_filter(category: str, model=Movement):
    if category == "restricted":
        condition = model.denial_code.in_(RESTRICTED_DENIAL_CODES)
    else:
        condition = or_(model.denial_code.is_(None), ~model.denial_code.in_(RESTRICTED_DENIAL_CODES))
    return and_(model.result == "denied", condition)


def parse_bound(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except ValueError as error:
        raise HTTPException(422, "Date filter must be ISO 8601") from error


def scan_conditions(model=Movement):
    approved, denied = model.result == "approved", model.result == "denied"
    automatic, manual = model.scan_type == "auto", model.scan_type == "manual"
    entry, exit_ = model.direction == "entry", model.direction == "exit"
    restricted, other = (denial_category_filter(category, model) for category in ("restricted", "other"))
    return {
        "totalScans": True, "totalApproved": approved, "totalDenied": denied,
        "totalEntries": approved & entry, "totalExits": approved & exit_,
        "totalAutomatic": automatic, "totalManual": manual,
        "totalRestricted": restricted, "totalOtherDenied": other,
        "automaticApproved": approved & automatic, "manualApproved": approved & manual,
        "automaticDenied": denied & automatic, "manualDenied": denied & manual,
        "autoEntry": approved & automatic & entry, "autoExit": approved & automatic & exit_,
        "manualEntry": approved & manual & entry, "manualExit": approved & manual & exit_,
        "restrictedAuto": restricted & automatic, "otherAuto": other & automatic,
        "restrictedManual": restricted & manual, "otherManual": other & manual,
    }


def listed_alert_records():
    # A retained review represents its trigger only when the live alert is gone.
    return union_all(
        select(Alert.id.label("id"), Alert.created_at.label("created_at"), Alert.data.label("data")),
        select(AlertReview.alert_id, AlertReview.alert_created_at, AlertReview.alert_data)
            .where(~select(Alert.id).where(Alert.id == AlertReview.alert_id).exists()),
    ).subquery("analytics_alerts")


def alert_zone_condition(records, zone_ids):
    """Explicit historical location takes precedence over current subject access."""
    checkpoint_id = func.nullif(func.btrim(records.c.data["checkpointId"].astext), "")
    zone_id = func.nullif(func.btrim(records.c.data["zoneId"].astext), "")
    return or_(
        checkpoint_id.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
        and_(checkpoint_id.is_(None), zone_id.in_(zone_ids)),
        and_(checkpoint_id.is_(None), zone_id.is_(None), subject_zone_condition(zone_ids)),
    )


@router.get("/dashboard-analytics")
async def dashboard_analytics(
    subjectGroup: str = Query("people", pattern="^(people|hardware)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    zone_ids = await admin_zone_ids(db, actor)
    end = min(parse_bound(endAt), datetime.now(timezone.utc)) if endAt else datetime.now(timezone.utc)
    start = parse_bound(startAt) if startAt else None
    if start and start > end:
        raise HTTPException(422, "Range start must be before range end")
    try:
        previous_start = start - (end - start + timedelta(milliseconds=1)) if start else None
    except OverflowError as error:
        raise HTTPException(422, "Date range is too large for a comparison period") from error
    history = movement_history(hardware_only=True) if subjectGroup == "hardware" else Movement
    scan_filters = scan_conditions(history)
    periods = {"current": history.occurred_at <= end}
    if start:
        periods["current"] &= history.occurred_at >= start
        periods["previous"] = and_(history.occurred_at >= previous_start, history.occurred_at < start)
    columns = [func.count().filter(period & condition).label(f"{name}_{key}")
        for name, period in periods.items() for key, condition in scan_filters.items()]
    kinds = ["hardware"] if subjectGroup == "hardware" else ["employee", "visitor"]
    movement_query = select(*columns).where(history.subject_type.in_(kinds), history.occurred_at <= end,
        checkpoint_zone_condition(history, zone_ids))
    if history is Movement:
        movement_query = movement_query.where(canonical_movement_filter())
    if previous_start:
        movement_query = movement_query.where(history.occurred_at >= previous_start)
    records = listed_alert_records()
    explicit_identity = func.coalesce(AlertReview.subject_id, func.nullif(func.btrim(records.c.data["subjectId"].astext), ""))
    legacy_identity = explicit_identity.is_(None) & (func.lower(Subject.barcode) == func.lower(func.btrim(records.c.data["barcode"].astext)))
    alert_subject = or_(Subject.id == explicit_identity, legacy_identity)
    excluded = or_(records.c.data["manualReview"].astext == "true",
        records.c.data["ruleId"].astext.in_(["rule-manual-review", "rule-unknown-barcode"]),
        records.c.data["title"].astext.ilike("Unknown barcode%"),
        records.c.data["title"].astext.ilike("Access decision denied"))
    alert_periods = {"current": records.c.created_at <= end}
    if start:
        alert_periods["current"] &= records.c.created_at >= start
        alert_periods["previous"] = and_(records.c.created_at >= previous_start, records.c.created_at < start)
    alert_query = select(*(func.count().filter(condition).label(name) for name, condition in alert_periods.items()))\
        .select_from(records).outerjoin(AlertReview, AlertReview.alert_id == records.c.id)\
        .outerjoin(Subject, alert_subject).where(~func.coalesce(excluded, False),
            alert_zone_condition(records, zone_ids))
    # Unbound alerts belong to the people overview, never to the hardware view.
    alert_query = alert_query.where(Subject.kind == "hardware" if subjectGroup == "hardware"
        else or_(Subject.kind.in_(kinds), Subject.id.is_(None)))
    if previous_start:
        alert_query = alert_query.where(records.c.created_at >= previous_start)
    movement_totals = movement_query.subquery("movement_totals")
    alert_totals = alert_query.subquery("alert_totals")
    inside_total = select(func.count()).select_from(PresenceState).join(
        Subject, Subject.id == PresenceState.subject_id
    ).where(Subject.kind.in_(kinds), PresenceState.state == "inside",
        subject_zone_condition(zone_ids)).scalar_subquery()
    summary = (await db.execute(select(
        *movement_totals.c,
        *alert_totals.c,
        inside_total.label("active_inside"),
    ).select_from(movement_totals.join(alert_totals, true())))).mappings().one()
    def period_payload(name):
        values = {key: int(summary[f"{name}_{key}"] or 0) for key in scan_filters}
        return {"scanAnalytics": {**{key: value for key, value in values.items() if key.startswith("total")},
            "activeInside": int(summary["active_inside"] or 0)}, "breakdown": values,
            "alertCount": int(summary[name] or 0)}
    return {"current": period_payload("current"), "previous": period_payload("previous") if start else None,
        "startAt": start.isoformat() if start else None, "endAt": end.isoformat(),
        "previousStartAt": previous_start.isoformat() if previous_start else None,
        "previousEndAt": (start - timedelta(milliseconds=1)).isoformat() if start else None}


def build_activity_days(events, start: datetime, end: datetime):
    """Pair approved transitions, clip intervals, and split overnight work at facility midnight."""
    days: dict[str, dict] = {}
    def add_interval(begin, finish, kind):
        begin, finish = max(begin, start), min(finish, end)
        while begin < finish:
            local = begin.astimezone(FACILITY_ZONE)
            midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), FACILITY_ZONE)
            segment_end = min(finish, midnight.astimezone(timezone.utc))
            key = local.date().isoformat()
            day = days.setdefault(key, {"date": key, "workedHours": 0.0, "sessions": []})
            first = (begin - datetime.combine(local.date(), datetime.min.time(), FACILITY_ZONE)).total_seconds() / 3600
            last = first + (segment_end - begin).total_seconds() / 3600
            day["sessions"].append({"start": first, "end": last, "type": kind, "zIndex": 1 if kind == "work" else 2})
            if kind == "work":
                day["workedHours"] += last - first
            begin = segment_end
    current_entry = None
    last_exit = None
    for direction, timestamp in events:
        if direction == "entry" and current_entry is None:
            if last_exit and timestamp - last_exit <= timedelta(hours=2) and last_exit.astimezone(FACILITY_ZONE).date() == timestamp.astimezone(FACILITY_ZONE).date():
                add_interval(last_exit, timestamp, "break")
            current_entry = timestamp
        elif direction == "exit":
            if current_entry is not None:
                add_interval(current_entry, timestamp, "work")
                current_entry = None
            last_exit = timestamp
    if current_entry is not None:
        add_interval(current_entry, end, "work")
    for day in days.values():
        day["percentage"] = min(round(day["workedHours"] / 8 * 100), 100)
    return sorted(days.values(), key=lambda day: day["date"])


@router.get("/employee-activity")
async def employee_activity(
    subjectId: str = Query(..., min_length=1, max_length=200),
    days: int = Query(7, ge=1, le=365),
    endAt: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    zone_ids = await admin_zone_ids(db, actor)
    if not await db.scalar(select(Subject.id).where(Subject.id == subjectId, Subject.kind == "employee",
            subject_zone_condition(zone_ids))):
        raise HTTPException(404, "Employee not found")
    end = min(parse_bound(endAt), datetime.now(timezone.utc)) if endAt else datetime.now(timezone.utc)
    today_start = datetime.combine(end.astimezone(FACILITY_ZONE).date(), datetime.min.time(), FACILITY_ZONE).astimezone(timezone.utc)
    try:
        start = today_start - timedelta(days=days - 1)
        # Both periods include the same portion of their final facility day.
        previous_end = end - timedelta(days=days)
        previous_start = start - timedelta(days=days)
    except OverflowError as error:
        raise HTTPException(422, "Date range is too large for a comparison period") from error
    base = select(Movement.direction, Movement.occurred_at).where(Movement.subject_id == subjectId,
        Movement.subject_type == "employee", Movement.result == "approved", canonical_movement_filter(),
        checkpoint_zone_condition(Movement, zone_ids))
    seed = (await db.execute(base.where(Movement.occurred_at < previous_start)
        .order_by(Movement.occurred_at.desc(), Movement.id.desc()).limit(1))).first()
    rows = await bounded_rows(db, base.where(Movement.occurred_at >= previous_start, Movement.occurred_at <= end)
        .order_by(Movement.occurred_at, Movement.id), maximum=settings.DATA_ANALYTICS_MAX_ROWS)
    events = ([seed] if seed else []) + list(rows)
    current = build_activity_days(events, start, end)
    previous = build_activity_days(events, previous_start, previous_end)
    return {"days": current, "totalHours": sum(day["workedHours"] for day in current),
        "previousTotalHours": sum(day["workedHours"] for day in previous),
        "startAt": start.isoformat(), "endAt": end.isoformat(),
        "previousStartAt": previous_start.isoformat(), "previousEndAt": previous_end.isoformat()}


@router.get("/employee-activity-summary")
async def employee_activity_summary(
    days: int = Query(7, ge=1, le=365),
    endAt: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Return per-employee work hours per calendar day for one shared date range."""
    zone_ids = await admin_zone_ids(db, actor)
    end = min(parse_bound(endAt), datetime.now(timezone.utc)) if endAt else datetime.now(timezone.utc)
    today_start = datetime.combine(end.astimezone(FACILITY_ZONE).date(), datetime.min.time(), FACILITY_ZONE).astimezone(timezone.utc)
    try:
        start = today_start - timedelta(days=days - 1)
    except OverflowError as error:
        raise HTTPException(422, "Date range is too large") from error

    employee_ids = [row[0] for row in await bounded_rows(db,
        select(Subject.id).where(Subject.kind == "employee", subject_zone_condition(zone_ids))
        .order_by(Subject.id))]
    if not employee_ids:
        return {"averages": {}, "days": days, "startAt": start.isoformat(), "endAt": end.isoformat()}

    # Share the registry's indexed predecessor lookup and bounded range read.
    # Keeping this pairing logic centralized prevents the dashboard summary and
    # registry page from drifting on overnight work or pre-range open shifts.
    from registry_reads import employee_activity_rows
    events_by_employee = await employee_activity_rows(db, employee_ids, start, end, zone_ids=zone_ids)

    averages: dict[str, Optional[float]] = {}
    for employee_id, events in events_by_employee.items():
        if not events:
            averages[employee_id] = None
            continue
        activity_days = build_activity_days(events, start, end)
        total_hours = sum(day["workedHours"] for day in activity_days)
        averages[employee_id] = round(total_hours / days, 2)

    return {"averages": averages, "days": days, "startAt": start.isoformat(), "endAt": end.isoformat()}
