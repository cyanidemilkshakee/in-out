"""
Phase 2 — Presence endpoints.

GET /v1/presence        → current snapshot of all subjects' inside/outside state
GET /v1/presence/stream → SSE stream; emits an event whenever a scan changes presence
"""

import logging
import asyncio
import json
import time
from contextlib import aclosing
from typing import Annotated, AsyncGenerator

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, get_read_db
from data_limits import bounded_rows
from models import AccessPermission, HardwareAsset, Person, PresenceState, Subject, TerminalCheckpointAssignment
from schemas import PresenceEntry
from redis_client import subscribe_presence
from auth import has_admin_role, verify_admin_request, verify_admin_or_operator_request
from terminal_assignments import browser_identity
from presence_leases import acquire_stream_lease, renew_stream_lease, release_stream_lease
from event_outbox import read_event_revision, replay_events
from zone_access import admin_zone_ids, subject_zone_condition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/presence", tags=["presence"])


@router.get("", response_model=list[PresenceEntry])
async def get_presence_snapshot(
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> list[PresenceEntry]:
    """Return the current presence state for every known subject."""
    zone_ids = await admin_zone_ids(db, actor)
    stmt = (
        select(PresenceState, Subject)
        .join(Subject, Subject.id == PresenceState.subject_id)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids))
    )
    rows = await bounded_rows(db, stmt)
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


async def _current_checkpoint(claims: dict) -> str | None:
    # Use the primary database and a short transaction. A replica or a session
    # retained for the whole stream could keep a revoked assignment visible.
    async with AsyncSessionLocal() as db:
        return await db.scalar(select(TerminalCheckpointAssignment.checkpoint_id).where(
            TerminalCheckpointAssignment.terminal_identity == browser_identity(claims)))


def _operator_refresh_event(message: str, checkpoint_id: str | None, identity: str) -> str | None:
    """Expose refresh hints, never the global channel's private documents."""
    try:
        event = json.loads(message)
    except (TypeError, ValueError):
        return None
    if not isinstance(event, dict):
        return None
    event_type = event.get("type")
    if event_type == "terminal_assignment":
        return json.dumps({"type": "terminal_assignment"}) if event.get("terminalIdentity") == identity else None
    if checkpoint_id is None:
        return None
    # These events invalidate hardware or availability in the scoped terminal
    # bootstrap. They carry no subject, alert, or administrator metadata here.
    if event_type in {"data_changed", "alerts", "alert_acknowledged"}:
        return json.dumps({"type": "data_changed"})
    if event_type not in {"scan", "manual_review", "manual_review_consumed", "manual_review_decision", "terminal_notification_dismissed"}:
        return None
    for field in ("movement", "request"):
        document = event.get(field)
        if isinstance(document, dict) and document.get("checkpointId") == checkpoint_id:
            return json.dumps({"type": "data_changed"})
    return None


async def _sse_event_generator(request: Request, expires_at: float, claims: dict) -> AsyncGenerator[str, None]:
    """
    Yield SSE-formatted strings from the Redis presence channel until the
    client disconnects.
    """
    try:
        administrator = has_admin_role(claims)
        identity = browser_identity(claims) if not administrator else None
        checkpoint_id = await _current_checkpoint(claims) if not administrator else None
        async with aclosing(subscribe_presence()) as stream:
            async for message in stream:
                if time.time() >= expires_at or await request.is_disconnected():
                    break
                if not administrator:
                    current_checkpoint = await _current_checkpoint(claims)
                    if current_checkpoint != checkpoint_id:
                        checkpoint_id = current_checkpoint
                        yield 'data: {"type": "terminal_assignment"}\n\n'
                    if message is not None:
                        message = _operator_refresh_event(message, checkpoint_id, identity)
                        if message is None:
                            continue
                elif message is not None:
                    # Admins receive a refresh hint only; the event payload can
                    # contain subjects or decisions from other facility zones.
                    message = json.dumps({"type": "data_changed"})
                yield ": heartbeat\n\n" if message is None else f"data: {message}\n\n"
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("Error in SSE presence stream")


def _frame(payload: dict, *, revision: int | None = None, event: str | None = None) -> str:
    return ((f"id: {revision}\n" if revision is not None else "")
            + (f"event: {event}\n" if event else "")
            + "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n")


async def _versioned_sse(request: Request, expires_at: float, claims: dict, after: int):
    """Subscribe first, then bridge the snapshot/setup gap from committed rows."""
    ready = asyncio.Event()
    queue = asyncio.Queue(maxsize=256)
    queued_bytes = 0
    overflow = asyncio.Event()
    administrator = has_admin_role(claims)
    identity = browser_identity(claims) if not administrator else None
    checkpoint = await _current_checkpoint(claims) if not administrator else None

    async def pump():
        nonlocal queued_bytes
        try:
            async with aclosing(subscribe_presence(ready)) as stream:
                async for message in stream:
                    size = len(message.encode()) if isinstance(message, str) else 0
                    if queued_bytes + size > 1024 * 1024:
                        overflow.set()
                        return
                    try:
                        queue.put_nowait((True, message, size))
                        queued_bytes += size
                    except asyncio.QueueFull:
                        overflow.set()
                        return
        finally:
            # Also wake setup if Redis failed before it could subscribe.
            ready.set()
            if not overflow.is_set():
                await queue.put((False, None, 0))

    async def catch_up(through):
        async with AsyncSessionLocal() as db:
            return await replay_events(db, after, through)

    async def render(revision, payload):
        nonlocal checkpoint
        if administrator:
            return _frame({"type": "data_changed"}, revision=revision)
        if payload.get("type") == "terminal_assignment" and payload.get("terminalIdentity") == identity:
            checkpoint = await _current_checkpoint(claims)
        hint = _operator_refresh_event(json.dumps(payload), checkpoint, identity)
        if hint is not None:
            return _frame(json.loads(hint), revision=revision)
        # Advance the resumable cursor without exposing private documents.
        return _frame({"revision": revision}, revision=revision, event="cursor")

    task = asyncio.create_task(pump())
    try:
        await asyncio.wait_for(ready.wait(), timeout=5)
        if task.done() and task.exception():
            raise task.exception()
        async with AsyncSessionLocal() as db:
            through = await read_event_revision(db)
        events = await catch_up(through)
        if events is None or overflow.is_set():
            yield _frame({"type": "snapshot_required", "revision": through}, revision=through, event="snapshot_required")
            return
        for revision, payload in events:
            yield await render(revision, payload)
            after = revision
        yield _frame({"revision": through}, revision=through, event="ready")
        while not overflow.is_set() and time.time() < expires_at and not await request.is_disconnected():
            active, raw, size = await queue.get()
            queued_bytes -= size
            if not active:
                return
            if time.time() >= expires_at:
                return
            if raw is None:
                if not administrator:
                    current = await _current_checkpoint(claims)
                    if current != checkpoint:
                        checkpoint = current
                        yield _frame({"type": "terminal_assignment"})
                # Repair a committed event even if its publisher was restarted.
                async with AsyncSessionLocal() as db:
                    through = await read_event_revision(db)
                events = await catch_up(through)
                if events is None:
                    yield _frame({"type": "snapshot_required", "revision": through}, revision=through, event="snapshot_required")
                    return
                for revision, payload in events:
                    yield await render(revision, payload)
                    after = revision
                yield ": heartbeat\n\n"
                continue
            try:
                payload = json.loads(raw)
                revision = payload.get("revision") if isinstance(payload, dict) else None
                if not isinstance(revision, int) or isinstance(revision, bool):
                    # Mixed-version deployments must reconcile legacy messages.
                    yield _frame({"type": "snapshot_required"}, event="snapshot_required")
                    return
                if revision <= after:
                    continue
                if payload.get("previousRevision") != after:
                    events = await catch_up(revision)
                    if events is None:
                        yield _frame({"type": "snapshot_required", "revision": revision}, revision=revision, event="snapshot_required")
                        return
                else:
                    events = [(revision, payload)]
                for revision, payload in events:
                    yield await render(revision, payload)
                    after = revision
            except (ValueError, TypeError):
                continue
        if overflow.is_set():
            yield _frame({"type": "snapshot_required"}, event="snapshot_required")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Resumable presence stream interrupted")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@router.get("/stream")
async def stream_presence(request: Request, claims: dict = Depends(verify_admin_or_operator_request),
                          since: Annotated[int | None, Query(ge=0, le=9007199254740991)] = None) -> StreamingResponse:
    """
    Server-Sent Events stream of presence change events.

    Admins receive refresh-only hints and reload zone-scoped data. Operators
    receive only hints for their current checkpoint and assignment changes;
    the terminal bootstrap provides authorized data after a refresh.
    """
    last_id = request.headers.get("last-event-id")
    if last_id is not None:
        if not last_id.isascii() or not last_id.isdigit() or len(last_id) > 16 or int(last_id) > 9007199254740991:
            raise HTTPException(status_code=422, detail="Invalid event revision")
        since = int(last_id)
    lease = await acquire_stream_lease(claims)
    return LeasedStreamingResponse(
        (_sse_event_generator(request, float(claims["exp"]), claims) if since is None
         else _versioned_sse(request, float(claims["exp"]), claims, since)), lease=lease,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


class LeasedStreamingResponse(StreamingResponse):
    def __init__(self, *args, lease, **kwargs):
        super().__init__(*args, **kwargs)
        self.lease = lease

    async def __call__(self, scope, receive, send):
        async def maintain_lease(group):
            # Renewal must continue even when assignment lookup or response
            # sending is blocked. Otherwise a live stream could outlast its
            # lease and no longer count toward the shared stream caps.
            try:
                while time.time() < self.lease.expires_at:
                    if not await renew_stream_lease(self.lease):
                        # Losing the lease before token expiry means admission
                        # is no longer valid, so stop the response immediately.
                        # At token expiry, the SSE generator can finish its
                        # normal response instead of being cancelled mid-send.
                        if time.time() < self.lease.expires_at:
                            group.cancel_scope.cancel()
                        return
                    remaining = self.lease.expires_at - time.time()
                    if remaining > 0:
                        await anyio.sleep(min(10, remaining))
            except Exception:
                logger.exception("Presence stream lease renewal failed")
                group.cancel_scope.cancel()

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(maintain_lease, group)
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    group.cancel_scope.cancel()
        finally:
            # Sending can fail while the generator is suspended after yielding
            # an event. Close it explicitly so its Redis subscription is freed.
            with anyio.CancelScope(shield=True):
                try:
                    await self.body_iterator.aclose()
                finally:
                    await release_stream_lease(self.lease)
