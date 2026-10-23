"""Durable delivery in the existing worker; no network I/O in write requests."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
import logging
import uuid

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal
from models import EventOutbox, EventStreamState

logger = logging.getLogger(__name__)
MAX_EVENT_BYTES = 256 * 1024
MAX_REPLAY_EVENTS = 500
MAX_REPLAY_BYTES = 4 * 1024 * 1024

_ENQUEUE = text("""
    WITH revision AS (
      UPDATE event_stream_state SET revision=revision+1,
        previous_presence_revision=presence_revision,
        presence_revision=CASE WHEN :kind='presence' THEN revision+1 ELSE presence_revision END
      WHERE id=1 RETURNING revision,previous_presence_revision
    )
    INSERT INTO event_outbox(id,event_key,kind,payload)
    SELECT revision,:event_key,:kind,
      CASE WHEN :kind='presence' THEN CAST(:payload AS jsonb) ||
        jsonb_build_object('revision',revision,'previousRevision',previous_presence_revision)
      ELSE CAST(:payload AS jsonb) END FROM revision RETURNING id
""")


async def enqueue(db, kind: str, payload: dict) -> int:
    if kind not in {"presence", "workflow_start", "workflow_signal"} or not isinstance(payload, dict):
        raise ValueError("Invalid durable event")
    serialized = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    if len(serialized.encode()) > MAX_EVENT_BYTES:
        raise ValueError("Durable event exceeds its byte bound")
    # Finish business writes/locks before taking the tiny global revision lock.
    # Unlike nextval(), this counter cannot commit out of order and make a
    # snapshot cursor skip an earlier, still-uncommitted event.
    await db.flush()
    value = await db.scalar(_ENQUEUE, {"kind": kind, "payload": serialized, "event_key": str(uuid.uuid4())})
    if value is None:
        raise RuntimeError("Durable event state is not initialized")
    return int(value)


async def enqueue_presence(db, payload: dict) -> int:
    return await enqueue(db, "presence", payload)


async def enqueue_changed(db) -> int:
    return await enqueue_presence(db, {"type": "data_changed"})


async def enqueue_workflow_start(db, request_id: str, *, visitor=False) -> int:
    return await enqueue(db, "workflow_start", {
        "workflow": "VisitorApprovalWorkflow" if visitor else "PermissionOverrideWorkflow",
        "workflowId": ("visitor-" if visitor else "override-") + request_id, "args": [request_id]})


async def enqueue_workflow_signal(db, workflow_id: str, args: list) -> int:
    return await enqueue(db, "workflow_signal", {"workflowId": workflow_id, "args": args})


async def read_event_revision(db) -> int:
    # The cursor and its bundle must describe one MVCC snapshot. Otherwise an
    # aggregate read could include an event that catch-up then counts twice.
    if isinstance(db, AsyncSession) and not db.in_transaction():
        await db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    return int(await db.scalar(select(EventStreamState.presence_revision).where(EventStreamState.id == 1)) or 0)


async def replay_events(db, after: int, through: int):
    """Return complete bounded catch-up or None to require a fresh snapshot."""
    if after < 0 or through < after:
        return None
    events, size, cursor = [], 0, after
    while cursor < through:
        rows = (await db.execute(select(EventOutbox.id, EventOutbox.payload).where(
            EventOutbox.kind == "presence", EventOutbox.id > cursor, EventOutbox.id <= through,
        ).order_by(EventOutbox.id).limit(50))).all()
        if not rows:
            break
        for revision, payload in rows:
            size += len(json.dumps(payload, separators=(",", ":")).encode())
            if len(events) >= MAX_REPLAY_EVENTS or size > MAX_REPLAY_BYTES:
                return None
            events.append((int(revision), payload))
            cursor = int(revision)
        if len(rows) < 50:
            break
    # A missing predecessor is a retention/corruption gap, never a reason to
    # silently skip events. Workflow-only revisions legitimately have gaps.
    previous = after
    for revision, payload in events:
        if not isinstance(payload, dict) or payload.get("previousRevision") != previous:
            return None
        previous = revision
    return events if previous >= through else None


async def _deliver(kind: str, payload: dict):
    if kind == "presence":
        from redis_client import publish_presence_update
        await publish_presence_update(json.dumps(payload, separators=(",", ":")))
        return
    from temporal_worker import get_temporal_client, TASK_QUEUE
    from temporalio.exceptions import WorkflowAlreadyStartedError
    from temporalio.common import WorkflowIDReusePolicy
    from temporalio.service import RPCError, RPCStatusCode
    client = await get_temporal_client()
    if kind == "workflow_start":
        from models import PermissionRequestModel
        from manual_review_policy import MANUAL_REVIEW_TIMEOUT_MINUTES
        async with AsyncSessionLocal() as db:
            created = await db.scalar(select(PermissionRequestModel.created_at).where(
                PermissionRequestModel.id == payload["args"][0]))
        if created is None:
            return  # A removed request no longer has a deadline to maintain.
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        minutes = 30 if payload["workflow"] == "VisitorApprovalWorkflow" else MANUAL_REVIEW_TIMEOUT_MINUTES
        args = [payload["args"][0], (created + timedelta(minutes=minutes)).isoformat()]
        try:
            await client.start_workflow(payload["workflow"], args=args, id=payload["workflowId"],
                task_queue=TASK_QUEUE, id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                rpc_timeout=timedelta(seconds=5))
        except WorkflowAlreadyStartedError:
            pass
    else:
        try:
            await client.get_workflow_handle(payload["workflowId"]).signal(
                "admin_decision", args=payload["args"], rpc_timeout=timedelta(seconds=5))
        except RPCError as error:
            if error.status != RPCStatusCode.NOT_FOUND:
                raise
            async with AsyncSessionLocal() as db:
                pending_start = await db.scalar(select(EventOutbox.id).where(
                    EventOutbox.kind == "workflow_start", EventOutbox.delivered_at.is_(None),
                    EventOutbox.payload["workflowId"].astext == payload["workflowId"]).limit(1))
            if pending_start:
                raise  # A delayed start must not lose its later decision.
            # Already completed legacy workflows need no further notification;
            # the authenticated, committed database decision remains final.


async def dispatch_one(*, deliver=None, sessions=None) -> bool:
    sessions = sessions or AsyncSessionLocal
    deliver = deliver or _deliver
    owner = str(uuid.uuid4())
    async with sessions() as db:
        now = datetime.now(timezone.utc)
        item = await db.scalar(select(EventOutbox).where(EventOutbox.delivered_at.is_(None),
            EventOutbox.available_at <= now,
            (EventOutbox.lease_until.is_(None) | (EventOutbox.lease_until <= now)),
        ).order_by(EventOutbox.id).limit(1).with_for_update(skip_locked=True))
        if item is None:
            return False
        item.lease_owner, item.lease_until = owner, now + timedelta(seconds=30)
        item.attempts += 1
        identifier, kind, payload, attempts = item.id, item.kind, dict(item.payload), item.attempts
        await db.commit()
    try:
        await asyncio.wait_for(deliver(kind, payload), timeout=15)
    except asyncio.CancelledError:
        raise  # Expiring lease makes an interrupted dispatch recoverable.
    except Exception as error:
        # Exception messages/tracebacks can contain provider URLs, credentials,
        # or event documents. A category and attempt still make retries useful
        # to diagnose without disclosing any of those values.
        error_type = type(error).__name__
        logger.warning("Durable event delivery deferred: error=%s attempt=%s", error_type, attempts,
            extra={"event_id": identifier, "event_kind": kind, "error_type": error_type, "attempt": attempts})
        values = {"available_at": datetime.now(timezone.utc) + timedelta(seconds=min(60, 2 ** min(attempts, 6))),
            "lease_owner": None, "lease_until": None}
    else:
        values = {"delivered_at": datetime.now(timezone.utc), "lease_owner": None, "lease_until": None}
    async with sessions() as db:
        await db.execute(update(EventOutbox).where(EventOutbox.id == identifier, EventOutbox.lease_owner == owner).values(**values))
        await db.commit()
    return True


async def run_dispatcher(stop: asyncio.Event):
    next_cleanup = 0.0
    while not stop.is_set():
        try:
            busy = await dispatch_one()
            if asyncio.get_running_loop().time() >= next_cleanup:
                await prune_delivered()
                next_cleanup = asyncio.get_running_loop().time() + 60
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Durable event dispatcher unavailable")
            busy = False
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass


async def prune_delivered(*, sessions=None):
    """Bound technical replay storage; domain audit/history is unaffected."""
    sessions = sessions or AsyncSessionLocal
    async with sessions() as db:
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        await db.execute(text("""DELETE FROM event_outbox WHERE id IN (
            SELECT id FROM event_outbox WHERE delivered_at IS NOT NULL AND created_at < :cutoff
            ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED)"""), {"cutoff": cutoff})
        await db.commit()
