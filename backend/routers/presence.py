"""
Phase 2 — Presence endpoints.

GET /v1/presence        → current snapshot of all subjects' inside/outside state
GET /v1/presence/stream → SSE stream; emits an event whenever a scan changes presence
"""

import logging
import asyncio
import time
from contextlib import aclosing
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from models import PresenceState, Subject
from schemas import PresenceEntry
from redis_client import subscribe_presence
from auth import verify_authenticated_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/presence", tags=["presence"])


@router.get("", response_model=list[PresenceEntry])
async def get_presence_snapshot(
    db: AsyncSession = Depends(get_read_db),
) -> list[PresenceEntry]:
    """Return the current presence state for every known subject."""
    stmt = (
        select(PresenceState, Subject)
        .join(Subject, Subject.id == PresenceState.subject_id)
    )
    rows = (await db.execute(stmt)).all()
    return [
        PresenceEntry(
            subject_id=ps.subject_id,
            kind=sub.kind,
            barcode=sub.barcode,
            state=ps.state,
            last_scan_timestamp=ps.last_scan_timestamp,
            updated_at=ps.updated_at,
        )
        for ps, sub in rows
    ]


async def _sse_event_generator(request: Request, expires_at: float) -> AsyncGenerator[str, None]:
    """
    Yield SSE-formatted strings from the Redis presence channel until the
    client disconnects.
    """
    try:
        async with aclosing(subscribe_presence()) as stream:
            async for message in stream:
                if time.time() >= expires_at or await request.is_disconnected():
                    break
                yield ": heartbeat\n\n" if message is None else f"data: {message}\n\n"
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("Error in SSE presence stream")


@router.get("/stream")
async def stream_presence(request: Request, claims: dict = Depends(verify_authenticated_request)) -> StreamingResponse:
    """
    Server-Sent Events stream of presence change events.

    Each event is a JSON object:
      { "subject_id": "...", "kind": "employee|visitor|hardware",
        "state": "inside|outside", "timestamp": "<iso8601>" }

    Clients should open this with EventSource and update their local
    presence state on each message.
    """
    return StreamingResponse(
        _sse_event_generator(request, float(claims["exp"])),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
        },
    )
