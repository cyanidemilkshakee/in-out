"""
Movement log endpoints.

GET  /v1/movements                     — paginated, filterable movement history (enriched)
POST /v1/movements/save                — upsert a movement (auth-protected)
POST /v1/movements/sync                — mark queued movements as synced (auth-protected)
POST /v1/movements/conflicts/resolve   — mark conflicted movements as synced (auth-protected)
GET  /v1/movements/{id}/notes          — list notes for a movement
POST /v1/movements/{id}/notes          — add a note to a movement (auth-protected)
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, text, and_, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
import asyncio

from auth import verify_admin_request
from database import get_db, get_read_db
from models import Movement, MovementNote
from schemas import MovementEntry, MovementListResponse

logger = logging.getLogger(__name__)

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
    note: str


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

    Response includes:
    - items: paged movements
    - chartItems: up to 2000 recent matching movements (data JSONB only)
    - movementNotes: {event_id: [note, ...]} for paged items
    - total / page / pageSize / limit / offset
    - checkpoints: distinct checkpoint names found in movements
    """
    base = select(Movement)
    count_base = select(func.count()).select_from(Movement)

    filters = []
    if search:
        pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        filters.append(or_(*[Movement.data[k].astext.ilike(pattern) for k in ("subjectName", "barcode", "checkpoint", "reason")]))
    if checkpoint:
        filters.append(or_(Movement.checkpoint_id == checkpoint, Movement.data["checkpoint"].astext == checkpoint))
    if scanType:
        filters.append(Movement.scan_type == scanType)
    if subjectGroup:
        filters.append(Movement.subject_type == "hardware" if subjectGroup == "hardware" else Movement.subject_type.in_(["employee", "visitor"]))
    for value, lower in ((startAt, True), (endAt, False)):
        if value:
            try:
                bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if bound.tzinfo is None:
                    bound = bound.replace(tzinfo=timezone.utc)
            except ValueError:
                raise HTTPException(422, "Date filter must be ISO 8601")
            filters.append(Movement.occurred_at >= bound if lower else Movement.occurred_at <= bound)
    sort_columns = {"date": Movement.occurred_at, "time": Movement.occurred_at,
        "createdAt": Movement.occurred_at, "eventId": Movement.id, "type": Movement.subject_type,
        "name": Movement.data["subjectName"].astext, "barcode": Movement.data["barcode"].astext,
        "checkpoint": Movement.data["checkpoint"].astext, "direction": Movement.direction,
        "result": Movement.result, "scanType": Movement.scan_type,
        "reason": Movement.data["reason"].astext, "subjectType": Movement.subject_type}
    column = sort_columns.get(sortKey, Movement.occurred_at)
    ordering = column.asc() if sortDirection == "asc" else column.desc()

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
        except ValueError:
            raise HTTPException(status_code=422, detail="since must be a valid ISO 8601 timestamp")
        filters.append(Movement.occurred_at >= since_dt)

    if filters:
        base = base.where(*filters)
        count_base = count_base.where(*filters)

    # Use page/pageSize when provided (page takes precedence over raw offset)
    effective_limit = page_size if page_size != _DEFAULT_LIMIT else limit
    effective_offset = (page - 1) * effective_limit if page > 1 else offset

    # -- Run main query, chart query, and checkpoints in parallel --
    chart_base = select(Movement).where(*filters) if filters else select(Movement)
    chart_query = chart_base.order_by(Movement.occurred_at.desc()).limit(2000)

    cp_query = text(
        "SELECT DISTINCT data->>'checkpoint' AS cp FROM movements "
        "WHERE data ? 'checkpoint' ORDER BY 1"
    )

    total_result = await db.execute(count_base)
    rows_result = await db.execute(base.order_by(ordering, Movement.id).limit(effective_limit).offset(effective_offset))
    chart_result = await db.execute(chart_query)
    cp_result = await db.execute(cp_query)

    total = total_result.scalar_one()
    movements = rows_result.scalars().all()
    chart_rows = chart_result.scalars().all()
    checkpoint_names = [r[0] for r in cp_result.all() if r[0] is not None]

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
        "chartItems":     [{**m.data, "id": m.id, "syncState": m.sync_state, "createdAt": m.occurred_at.isoformat()} for m in chart_rows],
        "movementNotes":  notes_map,
        "total":          total,
        "page":           page,
        "pageSize":       effective_limit,
        "limit":          effective_limit,
        "offset":         effective_offset,
        "checkpoints":    checkpoint_names,
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
    if payload.eventIds:
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

    note = MovementNote(event_id=movement_id, note=payload.note)
    db.add(note)
    await db.commit()

    result = await db.execute(
        select(MovementNote.note)
        .where(MovementNote.event_id == movement_id)
        .order_by(MovementNote.id)
    )
    return [row[0] for row in result.all()]
