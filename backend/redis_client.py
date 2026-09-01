"""
Async Redis client singleton for Phase 2 pub/sub.

A single connection pool is shared for all publish operations.
SSE subscribers each get a dedicated pubsub object so they can
independently subscribe and unsubscribe without interfering.
"""

from typing import AsyncIterator
import redis.asyncio as aioredis

from config import settings

_redis_pool: aioredis.Redis | None = None


def get_redis_pool() -> aioredis.Redis:
    """Return the shared Redis connection pool, creating it on first call."""
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
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


async def subscribe_presence() -> AsyncIterator[str]:
    """
    Async generator that yields raw JSON strings from the presence channel.

    Each caller gets an independent pubsub object. The generator runs until
    the caller stops iterating (i.e. the SSE client disconnects).
    """
    redis = get_redis_pool()
    pubsub = redis.pubsub()
    await pubsub.subscribe(PRESENCE_CHANNEL)
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                yield message["data"]
    finally:
        await pubsub.unsubscribe(PRESENCE_CHANNEL)
        await pubsub.aclose()
