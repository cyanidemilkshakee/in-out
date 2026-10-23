"""
Movement log endpoints.

GET  /v1/movements                     — paginated, filterable movement history (enriched)
POST /v1/movements/sync                — mark queued movements as synced (auth-protected)
POST /v1/movements/conflicts/resolve   — mark conflicted movements as synced (auth-protected)
GET  /v1/movements/{id}/notes          — list notes for a movement
POST /v1/movements/{id}/notes          — add a note to a movement (auth-protected)
"""

from datetime import datetime, timezone
import asyncio
import json
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, func, literal, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from facility_zones import CHECKPOINT_IDS, canonical_checkpoint_id
from database import get_db, get_read_db, rollback_after_error
from config import settings
from data_limits import bounded_rows
from models import Checkpoint, Movement, MovementNote
from redis_client import publish_data_changed
from event_outbox import enqueue_changed
from movement_analytics import router as analytics_router, canonical_movement_filter, denial_category_filter
from movement_history import movement_history, source_event_id
from zone_access import admin_zone_ids, checkpoint_zone_condition, require_checkpoint_scope
router = APIRouter(prefix="/v1/movements", tags=["movements"])
router.include_router(analytics_router)

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50
MAX_MAINTENANCE_BATCH = 200


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class MovementBatchRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    eventIds: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        min_length=1, max_length=MAX_MAINTENANCE_BATCH,
        description="Explicit movement IDs; 1 to 200 unique IDs per atomic batch.",
    )

    @field_validator("eventIds")
    @classmethod
    def unique_ids(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("Movement IDs must be unique within a batch")
        return values


class SyncRequest(MovementBatchRequest):
    pass


class ConflictResolveRequest(MovementBatchRequest):
    pass


class NoteRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    note: str = Field(min_length=1, max_length=2000)


def _movement_filters(
    *, search: Optional[str], checkpoint: Optional[str], scan_type_ui: Optional[str],
    subject_group: Optional[str], start_at: Optional[str], end_at: Optional[str],
    subject_id: Optional[str], result: Optional[str], direction: Optional[str],
    scan_type: Optional[str], subject_type: Optional[str], since: Optional[str],
    event_id: Optional[str] = None,
    denial_category: Optional[str] = None,
    model=Movement,
) -> list[Any]:
    # Direct references must resolve even when an event is older than the
    # ledger's default date range or belongs to the other subject tab.
    if event_id:
        return [func.lower(model.id) == event_id.strip().lower()]
    filters: list[Any] = [canonical_movement_filter()] if model is Movement else []
    if denial_category:
        filters.append(denial_category_filter(denial_category, model))
    if search:
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = "%" + escaped.lower() + "%"
        searchable = func.lower(
            model.id + literal(" ") +
            func.coalesce(model.data["subjectName"].astext, "") + literal(" ") +
            func.coalesce(model.data["barcode"].astext, "") + literal(" ") +
            func.coalesce(model.data["checkpoint"].astext, "") + literal(" ") +
            func.coalesce(model.data["reason"].astext, "")
        )
        filters.append(searchable.like(pattern, escape="\\"))
    if checkpoint:
        checkpoint = canonical_checkpoint_id(checkpoint)
        filters.append(or_(model.checkpoint_id == checkpoint, model.data["checkpoint"].astext == checkpoint))
    if scan_type_ui:
        filters.append(model.scan_type == scan_type_ui)
    if subject_group:
        filters.append(model.subject_type == "hardware" if subject_group == "hardware" else model.subject_type.in_(["employee", "visitor"]))
    for value, lower in ((start_at, True), (end_at, False)):
        if not value:
            continue
        try:
            bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(422, "Date filter must be ISO 8601") from error
        filters.append(model.occurred_at >= bound if lower else model.occurred_at <= bound)
    if subject_id:
        filters.append(model.subject_id == subject_id)
    if result:
        filters.append(model.result == result)
    if direction:
        filters.append(model.direction == direction)
    if scan_type:
        filters.append(model.scan_type == scan_type)
    if subject_type:
        filters.append(model.subject_type == subject_type)
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            if since_dt.tzinfo is None:
                since_dt = since_dt.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="since must be a valid ISO 8601 timestamp") from error
        filters.append(model.occurred_at >= since_dt)
    return filters


# ---------------------------------------------------------------------------
# GET /v1/movements  (enriched)
# ---------------------------------------------------------------------------

@router.get("")
async def list_movements(
    eventId: Optional[str] = Query(None, min_length=1, max_length=128),
    search: Optional[str] = Query(None),
    checkpoint: Optional[str] = Query(None),
    scanType: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subjectGroup: Optional[str] = Query(None, pattern="^(people|hardware)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    denialCategory: Optional[str] = Query(None, pattern="^(restricted|other)$"),
    sortKey: Optional[str] = Query(None),
    sortDirection: str = Query("desc", pattern="^(asc|desc)$"),
    subject_id: Optional[str] = Query(None, description="Filter by subject ID"),
    result: Optional[str] = Query(None, pattern="^(approved|denied)$"),
    direction: Optional[str] = Query(None, pattern="^(entry|exit)$"),
    scan_type: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subject_type: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    since: Optional[str] = Query(None, description="ISO 8601 lower-bound for occurred_at"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    page: int = Query(1, ge=1),
    page_size: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT, alias="pageSize"),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Paginated movement log (newest-first).

    The response contains only the requested table page and its notes. Chart
    data is supplied by /v1/movements/analytics so paging never transfers a
    second, unbounded result set.
    """
    history = (Movement if subjectGroup == "people" and not eventId else
        movement_history(include_replaced=bool(eventId), hardware_only=subjectGroup == "hardware" and not eventId))
    base = select(history)
    count_base = select(func.count()).select_from(history)

    filters = _movement_filters(
        search=search, checkpoint=checkpoint, scan_type_ui=scanType, subject_group=subjectGroup,
        start_at=startAt, end_at=endAt, subject_id=subject_id, result=result,
        direction=direction, scan_type=scan_type, subject_type=subject_type, since=since, event_id=eventId,
        denial_category=denialCategory,
        model=history,
    )
    zone_ids = await admin_zone_ids(db, actor)
    filters.append(checkpoint_zone_condition(history, zone_ids))
    sort_columns = {"date": history.occurred_at, "time": history.occurred_at,
        "createdAt": history.occurred_at, "eventId": history.id, "type": history.subject_type,
        "name": history.data["subjectName"].astext, "barcode": history.data["barcode"].astext,
        "checkpoint": history.data["checkpoint"].astext, "direction": history.direction,
        "result": history.result, "scanType": history.scan_type,
        "reason": history.data["reason"].astext, "subjectType": history.subject_type}
    column = sort_columns.get(sortKey, history.occurred_at)
    ordering = column.asc() if sortDirection == "asc" else column.desc()

    if filters:
        base = base.where(*filters)
        count_base = count_base.where(*filters)

    # Use page/pageSize when provided (page takes precedence over raw offset)
    effective_limit = page_size if page_size != _DEFAULT_LIMIT else limit
    effective_offset = (page - 1) * effective_limit if page > 1 else offset

    total_result = await db.execute(count_base)
    rows_result = await db.execute(base.order_by(ordering, history.id).limit(effective_limit).offset(effective_offset))

    total = total_result.scalar_one()
    movements = rows_result.scalars().all()

    item_ids = sorted({source_event_id(m) for m in movements})

    # -- Notes for paged items --
    notes_map: dict[str, list[str]] = {}
    if item_ids:
        note_rows = await bounded_rows(db,
            select(MovementNote.event_id, MovementNote.note)
            .where(MovementNote.event_id.in_(item_ids))
            .order_by(MovementNote.event_id, MovementNote.id)
        )
        for event_id, note in note_rows:
            notes_map.setdefault(event_id, []).append(note)
        for movement in movements:
            parent_id = source_event_id(movement)
            if parent_id != movement.id and parent_id in notes_map:
                notes_map[movement.id] = notes_map[parent_id]

    return {
        "items": [
            {
                "id":           m.id,
                "subject_id":   m.subject_id,
                "checkpoint_id": m.checkpoint_id,
                "occurred_at":  m.occurred_at.isoformat() if m.occurred_at else None,
                "denial_code":  m.denial_code,
                "result":       m.result,
                "direction":    m.direction,
                "scan_type":    m.scan_type,
                "subject_type": m.subject_type,
                "sync_state":   m.sync_state,
                "data":         m.data,
            }
            for m in movements
        ],
        "movementNotes":  notes_map,
        "total":          total,
        "page":           page,
        "pageSize":       effective_limit,
        "limit":          effective_limit,
        "offset":         effective_offset,
    }


# ---------------------------------------------------------------------------
# GET /v1/movements/analytics
# ---------------------------------------------------------------------------

@router.get("/analytics")
async def movement_analytics(
    eventId: Optional[str] = Query(None, min_length=1, max_length=128),
    search: Optional[str] = Query(None),
    checkpoint: Optional[str] = Query(None),
    scanType: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subjectGroup: Optional[str] = Query(None, pattern="^(people|hardware)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    subject_id: Optional[str] = Query(None),
    denialCategory: Optional[str] = Query(None, pattern="^(restricted|other)$"),
    result: Optional[str] = Query(None, pattern="^(approved|denied)$"),
    direction: Optional[str] = Query(None, pattern="^(entry|exit)$"),
    scan_type: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subject_type: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    since: Optional[str] = Query(None),
    bucket: str = Query("hour", pattern="^(hour|day)$"),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Return compact movement aggregates plus a bounded chart sample.

    ``buckets`` is the scalable contract for charts. ``items`` remains a
    capped compatibility sample while the existing report UI is migrated away
    from raw event charts.
    """
    history = (Movement if subjectGroup == "people" and not eventId else
        movement_history(include_replaced=bool(eventId), hardware_only=subjectGroup == "hardware" and not eventId))
    filters = _movement_filters(
        search=search, checkpoint=checkpoint, scan_type_ui=scanType, subject_group=subjectGroup,
        start_at=startAt, end_at=endAt, subject_id=subject_id, result=result,
        direction=direction, scan_type=scan_type, subject_type=subject_type, since=since, event_id=eventId,
        denial_category=denialCategory,
        model=history,
    )
    zone_ids = await admin_zone_ids(db, actor)
    filters.append(checkpoint_zone_condition(history, zone_ids))
    where = filters if filters else []
    bucket_column = func.date_trunc(bucket, history.occurred_at).label("bucket")
    summary_result = await db.execute(select(
        func.count().label("total"),
        func.count().filter(history.result == "approved").label("approved"),
        func.count().filter(history.result == "denied").label("denied"),
    ).select_from(history).where(*where))
    bucket_rows = await bounded_rows(db,
        select(bucket_column, func.count().label("count"))
        .where(*where)
        .group_by(bucket_column)
        .order_by(bucket_column)
    )
    sample_result = await db.execute(
        select(history).where(*where).order_by(history.occurred_at.desc(), history.id).limit(500)
    )
    checkpoint_result = await db.execute(select(Checkpoint).where(
        Checkpoint.id.in_(CHECKPOINT_IDS), Checkpoint.zone_id.in_(zone_ids))
        .order_by(Checkpoint.zone_id, Checkpoint.id))
    summary = summary_result.mappings().one()
    return {
        "summary": {key: int(value or 0) for key, value in summary.items()},
        "buckets": [
            {"start": row._mapping["bucket"].isoformat(), "count": int(row._mapping["count"])}
            for row in bucket_rows
        ],
        "items": [
            {**movement.data, "id": movement.id, "syncState": movement.sync_state,
             "createdAt": movement.occurred_at.isoformat()}
            for movement in sample_result.scalars().all()
        ],
        "checkpoints": [{**(checkpoint.data or {}), "id": checkpoint.id}
            for checkpoint in checkpoint_result.scalars().all()],
    }


# ---------------------------------------------------------------------------
# POST /v1/movements/sync
# ---------------------------------------------------------------------------

async def _sync_movement_batch(db, event_ids, expected_state, zone_ids):
    """Validate the complete bounded result before committing any state change."""
    try:
        requested = (await db.execute(select(Movement.id, Checkpoint.zone_id)
            .join(Checkpoint, Checkpoint.id == Movement.checkpoint_id)
            .where(Movement.id.in_(event_ids)))).all()
        if any(zone_id not in zone_ids for _, zone_id in requested):
            raise HTTPException(status_code=403, detail="One or more movements are outside your assigned zone scope")
        rows = list(await db.scalars(select(Movement).where(
            Movement.id.in_(event_ids), Movement.sync_state == expected_state,
        ).order_by(Movement.id).with_for_update().execution_options(populate_existing=True)))
        records, size = [], 2  # JSON array brackets.
        for row in rows:
            record = {**row.data, "id": row.id, "syncState": "synced"}
            size += len(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
            size += 1 if records else 0
            if size > settings.MAX_DATA_RESPONSE_BYTES:
                raise HTTPException(422, detail={
                    "code": "movement_batch_response_too_large",
                    "message": "Movement batch is too large; select fewer movement IDs",
                })
            records.append(record)
        if not rows:
            # A repeated request or an absent/ineligible ID is a safe no-op.
            return []
        await db.execute(update(Movement).where(Movement.id.in_([row.id for row in rows]))
                         .values(sync_state="synced"))
        await enqueue_changed(db)
        await db.commit()
        return records
    except (Exception, asyncio.CancelledError):
        await rollback_after_error(db)
        raise


@router.post("/sync")
async def sync_movements(
    payload: SyncRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    """
    Mark an explicit batch of up to 200 queued movements as synced atomically.
    Missing, null, empty, duplicate, and oversized batches are rejected.
    Existing non-queued or absent IDs are ignored, preserving retry behavior.
    """
    return await _sync_movement_batch(db, payload.eventIds, "queued", await admin_zone_ids(db, _admin))


# ---------------------------------------------------------------------------
# POST /v1/movements/conflicts/resolve
# ---------------------------------------------------------------------------

@router.post("/conflicts/resolve")
async def resolve_conflicts(
    payload: ConflictResolveRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    """Mark an explicit bounded batch of conflicts as synced atomically."""
    return await _sync_movement_batch(db, payload.eventIds, "conflict", await admin_zone_ids(db, _admin))


# ---------------------------------------------------------------------------
# GET /v1/movements/{id}/notes
# ---------------------------------------------------------------------------

async def _physical_note_event_id(db: AsyncSession, movement_id: str) -> Optional[str]:
    physical_id = await db.scalar(select(Movement.id).where(Movement.id == movement_id))
    if physical_id:
        return physical_id
    history = movement_history(include_replaced=True, hardware_only=True)
    return await db.scalar(select(history.data["sourceEventId"].astext).where(history.id == movement_id))


async def _require_movement_scope(db: AsyncSession, actor: dict, movement_id: str) -> None:
    checkpoint_id = await db.scalar(select(Movement.checkpoint_id).where(Movement.id == movement_id))
    if checkpoint_id is None:
        history = movement_history(include_replaced=True, hardware_only=True)
        checkpoint_id = await db.scalar(select(history.checkpoint_id).where(history.id == movement_id))
    if not checkpoint_id:
        raise HTTPException(status_code=404, detail="Movement not found")
    await require_checkpoint_scope(db, actor, checkpoint_id)


@router.get("/{movement_id}/notes")
async def get_movement_notes(
    movement_id: str,
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> list[str]:
    """Return the list of notes for a movement, ordered by insertion order."""
    await _require_movement_scope(db, actor, movement_id)
    physical_id = await _physical_note_event_id(db, movement_id)
    if physical_id is None:
        return []
    rows = await bounded_rows(db,
        select(MovementNote.note)
        .where(MovementNote.event_id == physical_id)
        .order_by(MovementNote.id)
    )
    return [row[0] for row in rows]


# ---------------------------------------------------------------------------
# POST /v1/movements/{id}/notes
# ---------------------------------------------------------------------------

@router.post("/{movement_id}/notes")
async def add_movement_note(
    movement_id: str,
    payload: NoteRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> list[str]:
    """Add a note to a movement and return the updated list of notes."""
    # A hardware-history reference shares the physical scan's notes. Only this
    # annotation route resolves virtual IDs; admission/review writes do not.
    await _require_movement_scope(db, _admin, movement_id)
    physical_id = await _physical_note_event_id(db, movement_id)
    if physical_id is None:
        raise HTTPException(status_code=404, detail="Movement not found")

    note = MovementNote(event_id=physical_id, note=payload.note, created_at=datetime.now(timezone.utc))
    db.add(note)
    await db.flush()
    # Check the complete reply before committing. A capacity rejection must
    # not report failure after the note has already been persisted.
    rows = await bounded_rows(db,
        select(MovementNote.note)
        .where(MovementNote.event_id == physical_id)
        .order_by(MovementNote.id)
    )
    await enqueue_changed(db)
    await db.commit()
    return [row[0] for row in rows]
