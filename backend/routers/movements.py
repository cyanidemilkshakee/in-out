"""
Movement log endpoints.

GET  /v1/movements                     — paginated, filterable movement history (enriched)
POST /v1/movements/save                — upsert a movement (auth-protected)
POST /v1/movements/sync                — mark queued movements as synced (auth-protected)
POST /v1/movements/conflicts/resolve   — mark conflicted movements as synced (auth-protected)
GET  /v1/movements/{id}/notes          — list notes for a movement
POST /v1/movements/{id}/notes          — add a note to a movement (auth-protected)
"""

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, func, and_, literal, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_db, get_read_db
from models import Checkpoint, Movement, MovementNote
router = APIRouter(prefix="/v1/movements", tags=["movements"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class MovementSaveRequest(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    subject_id: str
    checkpoint_id: str
    occurred_at: Optional[str] = None
    denial_code: Optional[str] = None
    result: str
    direction: str
    scan_type: str
    subject_type: str
    sync_state: Optional[str] = "queued"
    data: Optional[dict[str, Any]] = None


class SyncRequest(BaseModel):
    eventIds: Optional[list[str]] = None


class ConflictResolveRequest(BaseModel):
    eventIds: list[str]


class NoteRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    note: str = Field(min_length=1, max_length=2000)


def _movement_filters(
    *, search: Optional[str], checkpoint: Optional[str], scan_type_ui: Optional[str],
    subject_group: Optional[str], start_at: Optional[str], end_at: Optional[str],
    subject_id: Optional[str], result: Optional[str], direction: Optional[str],
    scan_type: Optional[str], subject_type: Optional[str], since: Optional[str],
) -> list[Any]:
    filters: list[Any] = []
    if search:
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = "%" + escaped.lower() + "%"
        searchable = func.lower(
            func.coalesce(Movement.data["subjectName"].astext, "") + literal(" ") +
            func.coalesce(Movement.data["barcode"].astext, "") + literal(" ") +
            func.coalesce(Movement.data["checkpoint"].astext, "") + literal(" ") +
            func.coalesce(Movement.data["reason"].astext, "")
        )
        filters.append(searchable.like(pattern, escape="\\"))
    if checkpoint:
        filters.append(or_(Movement.checkpoint_id == checkpoint, Movement.data["checkpoint"].astext == checkpoint))
    if scan_type_ui:
        filters.append(Movement.scan_type == scan_type_ui)
    if subject_group:
        filters.append(Movement.subject_type == "hardware" if subject_group == "hardware" else Movement.subject_type.in_(["employee", "visitor"]))
    for value, lower in ((start_at, True), (end_at, False)):
        if not value:
            continue
        try:
            bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(422, "Date filter must be ISO 8601") from error
        filters.append(Movement.occurred_at >= bound if lower else Movement.occurred_at <= bound)
    if subject_id:
        filters.append(Movement.subject_id == subject_id)
    if result:
        filters.append(Movement.result == result)
    if direction:
        filters.append(Movement.direction == direction)
    if scan_type:
        filters.append(Movement.scan_type == scan_type)
    if subject_type:
        filters.append(Movement.subject_type == subject_type)
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            if since_dt.tzinfo is None:
                since_dt = since_dt.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(status_code=422, detail="since must be a valid ISO 8601 timestamp") from error
        filters.append(Movement.occurred_at >= since_dt)
    return filters


# ---------------------------------------------------------------------------
# GET /v1/movements  (enriched)
# ---------------------------------------------------------------------------

@router.get("")
async def list_movements(
    search: Optional[str] = Query(None),
    checkpoint: Optional[str] = Query(None),
    scanType: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subjectGroup: Optional[str] = Query(None, pattern="^(people|hardware)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
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
) -> dict[str, Any]:
    """
    Paginated movement log (newest-first).

    The response contains only the requested table page and its notes. Chart
    data is supplied by /v1/movements/analytics so paging never transfers a
    second, unbounded result set.
    """
    base = select(Movement)
    count_base = select(func.count()).select_from(Movement)

    filters = _movement_filters(
        search=search, checkpoint=checkpoint, scan_type_ui=scanType, subject_group=subjectGroup,
        start_at=startAt, end_at=endAt, subject_id=subject_id, result=result,
        direction=direction, scan_type=scan_type, subject_type=subject_type, since=since,
    )
    sort_columns = {"date": Movement.occurred_at, "time": Movement.occurred_at,
        "createdAt": Movement.occurred_at, "eventId": Movement.id, "type": Movement.subject_type,
        "name": Movement.data["subjectName"].astext, "barcode": Movement.data["barcode"].astext,
        "checkpoint": Movement.data["checkpoint"].astext, "direction": Movement.direction,
        "result": Movement.result, "scanType": Movement.scan_type,
        "reason": Movement.data["reason"].astext, "subjectType": Movement.subject_type}
    column = sort_columns.get(sortKey, Movement.occurred_at)
    ordering = column.asc() if sortDirection == "asc" else column.desc()

    if filters:
        base = base.where(*filters)
        count_base = count_base.where(*filters)

    # Use page/pageSize when provided (page takes precedence over raw offset)
    effective_limit = page_size if page_size != _DEFAULT_LIMIT else limit
    effective_offset = (page - 1) * effective_limit if page > 1 else offset

    total_result = await db.execute(count_base)
    rows_result = await db.execute(base.order_by(ordering, Movement.id).limit(effective_limit).offset(effective_offset))

    total = total_result.scalar_one()
    movements = rows_result.scalars().all()

    item_ids = [m.id for m in movements]

    # -- Notes for paged items --
    notes_map: dict[str, list[str]] = {}
    if item_ids:
        notes_result = await db.execute(
            select(MovementNote.event_id, MovementNote.note)
            .where(MovementNote.event_id.in_(item_ids))
            .order_by(MovementNote.event_id, MovementNote.id)
        )
        for event_id, note in notes_result.all():
            notes_map.setdefault(event_id, []).append(note)

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
    search: Optional[str] = Query(None),
    checkpoint: Optional[str] = Query(None),
    scanType: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subjectGroup: Optional[str] = Query(None, pattern="^(people|hardware)$"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    result: Optional[str] = Query(None, pattern="^(approved|denied)$"),
    direction: Optional[str] = Query(None, pattern="^(entry|exit)$"),
    scan_type: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subject_type: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    since: Optional[str] = Query(None),
    bucket: str = Query("hour", pattern="^(hour|day)$"),
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """Return compact movement aggregates plus a bounded chart sample.

    ``buckets`` is the scalable contract for charts. ``items`` remains a
    capped compatibility sample while the existing report UI is migrated away
    from raw event charts.
    """
    filters = _movement_filters(
        search=search, checkpoint=checkpoint, scan_type_ui=scanType, subject_group=subjectGroup,
        start_at=startAt, end_at=endAt, subject_id=None, result=result,
        direction=direction, scan_type=scan_type, subject_type=subject_type, since=since,
    )
    where = filters if filters else []
    bucket_column = func.date_trunc(bucket, Movement.occurred_at).label("bucket")
    summary_result = await db.execute(select(
        func.count().label("total"),
        func.count().filter(Movement.result == "approved").label("approved"),
        func.count().filter(Movement.result == "denied").label("denied"),
    ).where(*where))
    bucket_result = await db.execute(
        select(bucket_column, func.count().label("count"))
        .where(*where)
        .group_by(bucket_column)
        .order_by(bucket_column)
    )
    sample_result = await db.execute(
        select(Movement).where(*where).order_by(Movement.occurred_at.desc(), Movement.id).limit(500)
    )
    checkpoint_result = await db.execute(select(Checkpoint).order_by(Checkpoint.id))
    summary = summary_result.mappings().one()
    return {
        "summary": {key: int(value or 0) for key, value in summary.items()},
        "buckets": [
            {"start": row["bucket"].isoformat(), "count": int(row["count"])}
            for row in bucket_result.mappings().all()
        ],
        "items": [
            {**movement.data, "id": movement.id, "syncState": movement.sync_state,
             "createdAt": movement.occurred_at.isoformat()}
            for movement in sample_result.scalars().all()
        ],
        "checkpoints": [checkpoint.data.get("name", checkpoint.id) for checkpoint in checkpoint_result.scalars().all()],
    }


# ---------------------------------------------------------------------------
# POST /v1/movements/save  (must come before /{id} routes)
# ---------------------------------------------------------------------------

@router.post("/save")
async def save_movement(
    payload: MovementSaveRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Upsert a movement record. INSERT ... ON CONFLICT (id) DO UPDATE SET ..."""
    occurred_at: datetime
    if payload.occurred_at:
        try:
            occurred_at = datetime.fromisoformat(payload.occurred_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=422, detail="occurred_at must be a valid ISO 8601 timestamp")
    else:
        occurred_at = datetime.now(timezone.utc)

    stmt = pg_insert(Movement).values(
        id=payload.id,
        subject_id=payload.subject_id,
        checkpoint_id=payload.checkpoint_id,
        occurred_at=occurred_at,
        denial_code=payload.denial_code,
        result=payload.result,
        direction=payload.direction,
        scan_type=payload.scan_type,
        subject_type=payload.subject_type,
        sync_state=payload.sync_state or "queued",
        data=payload.data or {},
    ).on_conflict_do_update(
        index_elements=["id"],
        set_={
            "subject_id":    payload.subject_id,
            "checkpoint_id": payload.checkpoint_id,
            "occurred_at":   occurred_at,
            "denial_code":   payload.denial_code,
            "result":        payload.result,
            "direction":     payload.direction,
            "scan_type":     payload.scan_type,
            "subject_type":  payload.subject_type,
            "sync_state":    payload.sync_state or "queued",
            "data":          payload.data or {},
        },
    ).returning(Movement)

    result = await db.execute(stmt)
    await db.commit()
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=500, detail="Upsert failed")

    m = row[0]
    return {
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


# ---------------------------------------------------------------------------
# POST /v1/movements/sync
# ---------------------------------------------------------------------------

@router.post("/sync")
async def sync_movements(
    payload: SyncRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    """
    Mark queued movements as synced.
    If eventIds is provided, only those movements are updated.
    """
    from sqlalchemy import update as sa_update

    stmt = (
        sa_update(Movement)
        .where(Movement.sync_state == "queued")
    )
    if payload.eventIds is not None:
        stmt = stmt.where(Movement.id.in_(payload.eventIds))

    stmt = stmt.values(sync_state="synced").returning(Movement)
    result = await db.execute(stmt)
    await db.commit()

    return [
        {**m.data, "id": m.id, "syncState": m.sync_state} for (m,) in result.fetchall()
    ]


# ---------------------------------------------------------------------------
# POST /v1/movements/conflicts/resolve
# ---------------------------------------------------------------------------

@router.post("/conflicts/resolve")
async def resolve_conflicts(
    payload: ConflictResolveRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> list[dict[str, Any]]:
    """Mark conflicted movements as synced."""
    from sqlalchemy import update as sa_update

    stmt = (
        sa_update(Movement)
        .where(
            and_(
                Movement.sync_state == "conflict",
                Movement.id.in_(payload.eventIds),
            )
        )
        .values(sync_state="synced")
        .returning(Movement)
    )
    result = await db.execute(stmt)
    await db.commit()

    return [
        {**m.data, "id": m.id, "syncState": m.sync_state} for (m,) in result.fetchall()
    ]


# ---------------------------------------------------------------------------
# GET /v1/movements/{id}/notes
# ---------------------------------------------------------------------------

@router.get("/{movement_id}/notes")
async def get_movement_notes(
    movement_id: str,
    db: AsyncSession = Depends(get_read_db),
) -> list[str]:
    """Return the list of notes for a movement, ordered by insertion order."""
    result = await db.execute(
        select(MovementNote.note)
        .where(MovementNote.event_id == movement_id)
        .order_by(MovementNote.id)
    )
    return [row[0] for row in result.all()]


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
    # Verify the movement exists
    exists = await db.execute(select(Movement.id).where(Movement.id == movement_id))
    if not exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Movement not found")

    note = MovementNote(event_id=movement_id, note=payload.note, created_at=datetime.now(timezone.utc))
    db.add(note)
    await db.commit()

    result = await db.execute(
        select(MovementNote.note)
        .where(MovementNote.event_id == movement_id)
        .order_by(MovementNote.id)
    )
    return [row[0] for row in result.all()]
