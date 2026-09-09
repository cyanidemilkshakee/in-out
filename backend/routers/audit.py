"""
Audit event endpoints.

GET /v1/audit-events — paginated list of audit events with optional category filter
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import AuditEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/audit-events", tags=["audit"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get("")
async def list_audit_events(
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    category: Optional[str] = Query(None, description="Filter by data->>'category'"),
    db: AsyncSession = Depends(get_read_db),
) -> dict[str, Any]:
    """
    Return a paginated list of audit events ordered newest-first.
    Optional ?category= filters on the JSONB data->>'category' field.
    """
    q = select(AuditEvent).order_by(AuditEvent.created_at.desc())
    count_q = select(func.count()).select_from(AuditEvent)

    if category:
        q = q.where(AuditEvent.data["category"].astext == category)
        count_q = count_q.where(AuditEvent.data["category"].astext == category)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()

    rows_res = await db.execute(q.limit(limit).offset(offset))
    events = rows_res.scalars().all()

    return {
        "items":  [e.data for e in events],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }
