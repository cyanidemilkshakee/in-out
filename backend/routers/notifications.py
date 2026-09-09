"""
Notification endpoints.

GET   /v1/notifications          — list notifications, optional ?read=false filter
PATCH /v1/notifications/{id}/read — mark notification as read
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, get_read_db
from models import Notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    read: Optional[bool] = Query(None, description="Filter by read status"),
    db: AsyncSession = Depends(get_read_db),
) -> list[dict[str, Any]]:
    """
    Return up to 100 notifications ordered newest-first.
    Pass ?read=false to get only unread notifications.
    """
    q = select(Notification).order_by(Notification.created_at.desc()).limit(100)

    if read is not None:
        # Filter on data->>'read' JSON field
        if read:
            q = q.where(Notification.data["read"].astext == "true")
        else:
            # Unread = field missing OR explicitly false
            q = q.where(
                (Notification.data["read"].astext != "true")
                | Notification.data["read"].is_(None)
            )

    result = await db.execute(q)
    notifications = result.scalars().all()
    return [n.data for n in notifications]


@router.patch("/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Mark a notification as read by setting data[''read''] = True."""
    result = await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )
    notification = result.scalar_one_or_none()
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    updated_data = {**(notification.data or {}), "read": True}
    notification.data = updated_data
    await db.commit()
    await db.refresh(notification)
    return notification.data
