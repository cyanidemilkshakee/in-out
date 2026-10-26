"""
Bounded Redis clients for quotas/leases and presence events.

Event publishing and dedicated SSE subscriptions share an event pool,
separate from the quota pool so stream sockets cannot exhaust admission.
"""

import asyncio
from typing import AsyncIterator
import json
import logging
import redis.asyncio as aioredis
import anyio

from config import settings

_redis_pool: aioredis.Redis | None = None
_redis_loop: asyncio.AbstractEventLoop | None = None
_events_pool: aioredis.Redis | None = None
_events_loop: asyncio.AbstractEventLoop | None = None
logger = logging.getLogger(__name__)


def get_redis_pool() -> aioredis.Redis:
    """Return the quota/lease pool, creating it on first call."""
    global _redis_pool, _redis_loop
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    # Async Redis connections belong to the event loop that opened them. This
    # also keeps isolated test loops from reusing a pool after its loop closes.
    if _redis_pool is not None and running_loop is not None and _redis_loop is not running_loop:
        _redis_pool = None
        _redis_loop = None
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.QUOTA_REDIS_URL or settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
            max_connections=settings.QUOTA_REDIS_MAX_CONNECTIONS,
        )
        _redis_loop = running_loop
    return _redis_pool


def get_events_pool() -> aioredis.Redis:
    """Pubsub resources cannot consume the quota/lease connection pool."""
    global _events_pool, _events_loop
    running_loop = asyncio.get_running_loop()
    if _events_pool is not None and _events_loop is not running_loop:
        _events_pool = None
    if _events_pool is None:
        _events_pool = aioredis.from_url(settings.EVENTS_REDIS_URL or settings.REDIS_URL,
            encoding="utf-8", decode_responses=True, socket_connect_timeout=3,
            socket_timeout=3, max_connections=settings.EVENTS_REDIS_MAX_CONNECTIONS)
        _events_loop = running_loop
    return _events_pool


async def close_redis_pool() -> None:
    """Close both pools during application shutdown."""
    global _redis_pool, _redis_loop, _events_pool, _events_loop
    pool, owner_loop = _redis_pool, _redis_loop
    _redis_pool = None
    _redis_loop = None
    events, events_loop = _events_pool, _events_loop
    _events_pool = None
    _events_loop = None
    if events is not None and events_loop is asyncio.get_running_loop():
        await events.aclose()
    if pool is not None:
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        # The old loop has already closed, so its transports cannot be closed
        # from this loop. Detach that stale client and let its loop own cleanup.
        if owner_loop is None or owner_loop is running_loop:
            await pool.aclose()


PRESENCE_CHANNEL = "presence:updates"


async def publish_presence_update(payload: str) -> None:
    """Publish a JSON string to the presence broadcast channel."""
    redis = get_events_pool()
    await redis.publish(PRESENCE_CHANNEL, payload)


async def publish_data_changed() -> None:
    """Ask connected clients to refresh after a committed data mutation."""
    try:
        await publish_presence_update(json.dumps({"type": "data_changed"}))
    except Exception:
        # The mutation is already committed; a transient Redis issue must not
        # turn a successful write into a failed API response.
        logger.exception("Data changed; live publication failed")


async def subscribe_presence(ready: asyncio.Event | None = None) -> AsyncIterator[str | None]:
    """
    Async generator that yields raw JSON strings from the presence channel.

    Each caller gets an independent pubsub object. The generator runs until
    the caller stops iterating (i.e. the SSE client disconnects).
    """
    redis = get_events_pool()
    pubsub = redis.pubsub()
    try:
        await pubsub.subscribe(PRESENCE_CHANNEL)
        if ready is not None:
            # subscribe() writes the command; only the server acknowledgement
            # closes the race with a publisher on another Redis connection.
            acknowledgement = await pubsub.get_message(ignore_subscribe_messages=False, timeout=3)
            if not acknowledgement or acknowledgement.get("type") != "subscribe":
                raise RuntimeError("Presence subscription was not acknowledged")
            ready.set()
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
            if message is None:
                yield None  # SSE comment keeps idle connections alive through Kong.
            elif message["type"] == "message":
                yield message["data"]
    finally:
        with anyio.CancelScope(shield=True):
            try:
                await pubsub.unsubscribe(PRESENCE_CHANNEL)
            finally:
                await pubsub.aclose()
