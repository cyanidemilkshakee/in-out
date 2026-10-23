"""Bounded Registry pages and compact summaries; full histories stay on demand."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import selectinload

from config import settings
from critical_entry_restrictions import entry_restrictions_for_subjects
from data_limits import bounded_rows
from facility_zones import CHECKPOINT_IDS
from models import AccessPermission, Checkpoint, HardwareAsset, Movement, Person, PresenceState, Subject
from movement_analytics import FACILITY_ZONE, build_activity_days
from movement_history import canonical_movement_filter, movement_history
from subject_metadata import current_subject_metadata
from zone_access import checkpoint_zone_condition, subject_zone_condition


def subject_document(subject, restrictions=None):
    metadata = (current_subject_metadata(subject.kind, subject.person.data) if subject.person else
                dict(subject.hardware.data or {}) if subject.hardware else {})
    return {**metadata, "id": subject.id, "barcode": subject.barcode, "type": subject.kind,
            "inside": bool(subject.presence_state and subject.presence_state.state == "inside"),
            "entryRestriction": (restrictions or {}).get(subject.id)}


def movement_document(movement):
    return {**(movement.data or {}), "id": movement.id, "subject_id": movement.subject_id,
            "occurred_at": movement.occurred_at.isoformat(), "createdAt": movement.occurred_at.isoformat(),
            "checkpoint_id": movement.checkpoint_id, "denial_code": movement.denial_code,
            "result": movement.result, "direction": movement.direction, "scan_type": movement.scan_type,
            "subject_type": movement.subject_type, "sync_state": movement.sync_state}


def subject_search_conditions(kind, search):
    conditions = [Subject.kind.in_(("employee", "visitor")) if kind == "people" else Subject.kind == kind] if kind else []
    if isinstance(search, str) and search.strip():
        literal = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = "%" + literal + "%"
        metadata = case((Subject.kind == "hardware", HardwareAsset.data), else_=Person.data)
        conditions.append(or_(Subject.barcode.ilike(pattern, escape="\\"),
            *(metadata[field].astext.ilike(pattern, escape="\\")
              for field in ("name", "host", "company", "owner"))))
    return conditions


async def employee_activity_rows(db, employee_ids, start, end):
    if not employee_ids:
        return {}
    conditions = (Movement.subject_id.in_(employee_ids), Movement.subject_type == "employee",
                  Movement.result == "approved", canonical_movement_filter())
    prior = select(Movement.subject_id, Movement.direction, Movement.occurred_at,
        func.row_number().over(partition_by=Movement.subject_id,
            order_by=(Movement.occurred_at.desc(), Movement.id.desc())).label("event_rank"))\
        .where(*conditions, Movement.occurred_at < start).subquery()
    seeds = await bounded_rows(db, select(prior.c.subject_id, prior.c.direction, prior.c.occurred_at)
        .where(prior.c.event_rank == 1), maximum=settings.DATA_ANALYTICS_MAX_ROWS)
    rows = await bounded_rows(db, select(Movement.subject_id, Movement.direction, Movement.occurred_at)
        .where(*conditions, Movement.occurred_at >= start, Movement.occurred_at <= end)
        .order_by(Movement.subject_id, Movement.occurred_at, Movement.id), maximum=settings.DATA_ANALYTICS_MAX_ROWS)
    grouped = {employee_id: [] for employee_id in employee_ids}
    for row in [*seeds, *rows]:
        grouped[row.subject_id].append((row.direction, row.occurred_at))
    return grouped


def trend_summary(points, start, end, days, average):
    duration = timedelta(days=days)
    bucket_count = 7 if days == 7 else 10 if days == 30 else 12
    seconds = duration.total_seconds() / bucket_count
    buckets = [[] for _ in range(bucket_count)]
    previous = []
    for timestamp, value in points:
        if start <= timestamp <= end:
            index = min(bucket_count - 1, max(0, int((timestamp - start).total_seconds() / seconds)))
            buckets[index].append(value)
        elif start - duration <= timestamp < start:
            previous.append(value)
    def aggregate(values):
        return sum(values) / len(values) if average and values else sum(values)
    current = [value for bucket in buckets for value in bucket]
    value, prior = round(aggregate(current), 1), round(aggregate(previous), 1)
    return {"values": [round(aggregate(bucket), 1) for bucket in buckets], "value": value,
            "percentage": round(abs(value - prior) / prior * 100) if prior > 0 else 100 if value > 0 else 0,
            "isUp": value >= prior, "startAt": start.isoformat(), "endAt": end.isoformat()}


async def registry_trend(db, kind, days, end, zone_ids=None):
    start = end - timedelta(days=days)
    scope = subject_zone_condition(zone_ids) if zone_ids is not None else None
    if kind == "employee":
        employee_query = select(Subject.id).outerjoin(Person, Person.subject_id == Subject.id)\
            .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)\
            .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id).where(Subject.kind == kind)
        if scope is not None:
            employee_query = employee_query.where(scope)
        ids = [row[0] for row in await bounded_rows(db, employee_query)]
        events = await employee_activity_rows(db, ids, start - timedelta(days=days), end)
        points = []
        for employee_events in events.values():
            for period_start, period_end in ((start, end), (start - timedelta(days=days), start - timedelta(microseconds=1))):
                for day in build_activity_days(employee_events, period_start, period_end):
                    midnight = datetime.fromisoformat(day["date"]).replace(tzinfo=FACILITY_ZONE).astimezone(timezone.utc)
                    points.append((max(midnight, period_start), day["workedHours"]))
        return trend_summary(points, start, end, days, True)
    history = movement_history(hardware_only=True) if kind == "hardware" else Movement
    bucket_count = 7 if days == 7 else 10 if days == 30 else 12
    # Group in SQL into the exact current/previous chart buckets, never a sample.
    bucket_seconds = days * 86400 / bucket_count
    bucket = func.floor(func.extract("epoch", history.occurred_at - start) / bucket_seconds).label("bucket")
    query = select(bucket, func.count()).where(history.subject_type == kind,
        history.occurred_at >= start - timedelta(days=days), history.occurred_at <= end)
    if history is Movement:
        query = query.where(canonical_movement_filter())
    if zone_ids is not None:
        query = query.where(checkpoint_zone_condition(history, zone_ids))
    rows = (await db.execute(query.group_by(bucket))).all()
    values = [0] * bucket_count
    previous = 0
    for index, count in rows:
        index = int(index)
        if index < 0:
            previous += int(count)
        else:
            values[min(index, bucket_count - 1)] += int(count)
    value = sum(values)
    return {"values": values, "value": value, "percentage": round(abs(value - previous) / previous * 100)
            if previous else 100 if value else 0, "isUp": value >= previous,
            "startAt": start.isoformat(), "endAt": end.isoformat()}


async def registry_page(db, *, kind, limit, offset, search, days, sort_key, sort_direction, include_overview,
                        zone_ids=None):
    conditions = subject_search_conditions(kind, search)
    if zone_ids is not None:
        conditions.append(subject_zone_condition(zone_ids))
    metadata = case((Subject.kind == "hardware", HardwareAsset.data), else_=Person.data)
    source = select(Subject).outerjoin(Person, Person.subject_id == Subject.id)\
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)\
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)\
        .outerjoin(PresenceState, PresenceState.subject_id == Subject.id).where(*conditions)
    total = int(await db.scalar(select(func.count()).select_from(source.with_only_columns(Subject.id).subquery())) or 0)
    now = datetime.now(timezone.utc)
    today = datetime.combine(now.astimezone(FACILITY_ZONE).date(), datetime.min.time(), FACILITY_ZONE).astimezone(timezone.utc)
    activity_start = today - timedelta(days=days - 1)
    averages = {}
    sorted_activity = None
    if sort_key == "averageHours" and kind == "employee":
        ids = [row[0] for row in await bounded_rows(db, source.with_only_columns(Subject.id).order_by(Subject.id))]
        sorted_activity = await employee_activity_rows(db, ids, activity_start, now)
        averages = {subject_id: round(sum(day["workedHours"] for day in build_activity_days(events, activity_start, now)) / days, 2)
                    if events else None for subject_id, events in sorted_activity.items()}
        ids.sort(key=lambda subject_id: (averages[subject_id] if averages[subject_id] is not None else -1, subject_id),
                 reverse=sort_direction == "desc")
        selected = ids[offset:offset + limit]
        source = source.where(Subject.id.in_(selected))
        sort_column = case({subject_id: index for index, subject_id in enumerate(selected)}, value=Subject.id) if selected else Subject.id
        ordered = sort_column.asc()
    else:
        sort_column = (Subject.barcode if sort_key == "barcode" else
            func.coalesce(PresenceState.state == "inside", False) if sort_key == "inside" else
            select(func.max(Movement.occurred_at)).where(Movement.subject_id == Subject.id, canonical_movement_filter(),
                *( [checkpoint_zone_condition(Movement, zone_ids)] if zone_ids is not None else [] )).scalar_subquery()
            if sort_key == "latestScan" else func.lower(func.coalesce(metadata[sort_key].astext, "")))
        ordered = sort_column.desc() if sort_direction == "desc" else sort_column.asc()
        source = source.limit(limit).offset(offset)
    subjects = (await db.scalars(source.order_by(ordered, Subject.id).options(
        selectinload(Subject.person), selectinload(Subject.hardware), selectinload(Subject.presence_state)))).all()
    ids = [subject.id for subject in subjects]
    restrictions = await entry_restrictions_for_subjects(db, ids)
    documents = [subject_document(subject, restrictions) for subject in subjects]
    latest_query = select(Movement).where(Movement.subject_id.in_(ids), canonical_movement_filter())
    if zone_ids is not None:
        latest_query = latest_query.where(checkpoint_zone_condition(Movement, zone_ids))
    latest = (await db.scalars(latest_query
        .distinct(Movement.subject_id).order_by(Movement.subject_id, Movement.occurred_at.desc(), Movement.id.desc()))).all() if ids else []
    activity_days = {}
    if kind == "employee":
        activity = ({subject_id: sorted_activity[subject_id] for subject_id in ids} if sorted_activity is not None else
                    await employee_activity_rows(db, ids, activity_start, now))
        for subject_id, events in activity.items():
            day_data = build_activity_days(events, activity_start, now)
            activity_days[subject_id] = day_data[-1:]
            averages[subject_id] = round(sum(day["workedHours"] for day in day_data) / days, 2) if events else None
    result = {"kind": kind, "people": documents if kind != "hardware" else [],
              "hardwareAssets": documents if kind == "hardware" else [], "movements": [movement_document(row) for row in latest],
              "activityDays": activity_days, "averages": {subject_id: averages.get(subject_id) for subject_id in ids},
              "total": total, "limit": limit, "offset": offset,
              "checkpoints": [{**(checkpoint.data or {}), "id": checkpoint.id} for checkpoint in (await db.scalars(
                  select(Checkpoint).where(Checkpoint.id.in_(CHECKPOINT_IDS),
                      *([Checkpoint.zone_id.in_(zone_ids)] if zone_ids is not None else []))
                  .order_by(Checkpoint.zone_id, Checkpoint.id))).all()]}
    if include_overview:
        counter_filters = [Subject.kind == kind]
        if zone_ids is not None:
            counter_filters.append(subject_zone_condition(zone_ids))
        counters = (await db.execute(select(func.count().label("total"),
            func.count().filter(PresenceState.state == "inside").label("inside"),
            func.count().filter(metadata["status"].astext == "pending_approval").label("pending"),
            func.count().filter(metadata["status"].astext == "pre_approved").label("preApproved"),
            func.count().filter(metadata["status"].astext == "restricted").label("restricted"))
            .select_from(Subject).outerjoin(Person, Person.subject_id == Subject.id)
            .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
            .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
            .outerjoin(PresenceState, PresenceState.subject_id == Subject.id)
            .where(*counter_filters))).mappings().one()
        result.update(summary={key: int(value or 0) for key, value in counters.items()},
                      trend=await registry_trend(db, kind, days, now, zone_ids))
    return result


async def subject_profile(db, subject_id):
    from fastapi import HTTPException
    subject = await db.scalar(select(Subject).where(Subject.id == subject_id).options(
        selectinload(Subject.person), selectinload(Subject.hardware), selectinload(Subject.presence_state)))
    if subject is None:
        raise HTTPException(404, "Subject not found")
    restrictions = await entry_restrictions_for_subjects(db, [subject.id])
    permissions = [row[0].data for row in await bounded_rows(db,
        select(AccessPermission).where(AccessPermission.subject_id == subject.id).order_by(AccessPermission.id))]
    return {"hardwareAsset" if subject.kind == "hardware" else "person": subject_document(subject, restrictions),
            "permissions": permissions}
