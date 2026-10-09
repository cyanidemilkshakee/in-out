"""
Async Redis client singleton for Phase 2 pub/sub.

A single connection pool is shared for all publish operations.
SSE subscribers each get a dedicated pubsub object so they can
independently subscribe and unsubscribe without interfering.
"""

from typing import AsyncIterator
import json
import logging
import redis.asyncio as aioredis

from config import settings

_redis_pool: aioredis.Redis | None = None
logger = logging.getLogger(__name__)


def get_redis_pool() -> aioredis.Redis:
    """Return the shared Redis connection pool, creating it on first call."""
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
        )
    return _redis_pool


async def close_redis_pool() -> None:
    """Close the shared pool — called during application shutdown."""
    global _redis_pool
    if _redis_pool is not None:
        await _redis_pool.aclose()
        _redis_pool = None


PRESENCE_CHANNEL = "presence:updates"


async def publish_presence_update(payload: str) -> None:
    """Publish a JSON string to the presence broadcast channel."""
    redis = get_redis_pool()
    await redis.publish(PRESENCE_CHANNEL, payload)


async def publish_data_changed() -> None:
    """Ask connected clients to refresh after a committed data mutation."""
    try:
        await publish_presence_update(json.dumps({"type": "data_changed"}))
    except Exception:
        # The mutation is already committed; a transient Redis issue must not
        # turn a successful write into a failed API response.
        logger.exception("Data changed; live publication failed")


async def subscribe_presence() -> AsyncIterator[str | None]:
    """
    Async generator that yields raw JSON strings from the presence channel.

    Each caller gets an independent pubsub object. The generator runs until
    the caller stops iterating (i.e. the SSE client disconnects).
    """
    redis = get_redis_pool()
    pubsub = redis.pubsub()
    await pubsub.subscribe(PRESENCE_CHANNEL)
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
            if message is None:
                yield None  # SSE comment keeps idle connections alive through Kong.
            elif message["type"] == "message":
                yield message["data"]
    finally:
        await pubsub.unsubscribe(PRESENCE_CHANNEL)
        await pubsub.aclose()
