"""
Audit event endpoints.

GET /v1/audit-events — paginated list of audit events with optional category filter
"""

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import AuditEvent

router = APIRouter(prefix="/v1/audit-events", tags=["audit"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get("")
async def list_audit_events(
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    category: Optional[str] = Query(None, description="Filter by data->>'category'"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Return a paginated list of audit events ordered newest-first.
    Optional ?category= filters on the JSONB data->>'category' field.
    """
    q = select(AuditEvent)
    count_q = select(func.count()).select_from(AuditEvent)

    for value, is_start in ((startAt, True), (endAt, False)):
        if not value:
            continue
        try:
            bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(422, "Date filter must be ISO 8601") from error
        condition = AuditEvent.created_at >= bound if is_start else AuditEvent.created_at <= bound
        q = q.where(condition)
        count_q = count_q.where(condition)

    if category:
        q = q.where(AuditEvent.data["category"].astext == category)
        count_q = count_q.where(AuditEvent.data["category"].astext == category)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()

    rows_res = await db.execute(q.order_by(AuditEvent.created_at.desc(), AuditEvent.id).limit(limit).offset(offset))
    events = rows_res.scalars().all()

    return {
        "items":  [
            {
                **(e.data or {}),
                "id": e.id,
                "createdAt": (e.data or {}).get("createdAt") or (
                    e.created_at.isoformat() if e.created_at else None
                ),
            }
            for e in events
        ],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }
