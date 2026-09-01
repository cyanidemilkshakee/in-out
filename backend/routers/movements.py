"""
Phase 2 — Movement log endpoint.

GET /v1/movements   → paginated, filterable movement history
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import Movement
from schemas import MovementEntry, MovementListResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/movements", tags=["movements"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get("", response_model=MovementListResponse)
async def list_movements(
    subject_id: Optional[str] = Query(None, description="Filter by subject ID"),
    result: Optional[str] = Query(None, pattern="^(approved|denied)$"),
    direction: Optional[str] = Query(None, pattern="^(entry|exit)$"),
    scan_type: Optional[str] = Query(None, pattern="^(auto|manual)$"),
    subject_type: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    since: Optional[str] = Query(None, description="ISO 8601 lower-bound for occurred_at"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
) -> MovementListResponse:
    """
    Paginated movement log.

    All filter parameters are optional and combinable. Results are ordered
    newest-first (occurred_at DESC).
    """
    base = select(Movement)
    count_base = select(func.count()).select_from(Movement)

    filters = []
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
        from datetime import datetime, timezone
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            from fastapi import HTTPException
            raise HTTPException(status_code=422, detail="since must be a valid ISO 8601 timestamp")
        filters.append(Movement.occurred_at >= since_dt)

    if filters:
        base = base.where(*filters)
        count_base = count_base.where(*filters)

    total_result = await db.execute(count_base)
    total = total_result.scalar_one()

    rows_result = await db.execute(
        base.order_by(Movement.occurred_at.desc()).limit(limit).offset(offset)
    )
    movements = rows_result.scalars().all()

    return MovementListResponse(
        items=[
            MovementEntry(
                id=m.id,
                subject_id=m.subject_id,
                checkpoint_id=m.checkpoint_id,
                occurred_at=m.occurred_at,
                denial_code=m.denial_code,
                result=m.result,
                direction=m.direction,
                scan_type=m.scan_type,
                subject_type=m.subject_type,
                sync_state=m.sync_state,
                data=m.data,
            )
            for m in movements
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
