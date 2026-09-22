"""Short-lived dashboard cache with explicit mutation invalidation."""
from __future__ import annotations

import json
import logging
from typing import Any

from redis_client import get_redis_pool

logger = logging.getLogger(__name__)

_KEY = "dashboard:summary:v1"
_TTL_SECONDS = 15


async def get_dashboard_cache() -> dict[str, Any] | None:
    try:
        payload = await get_redis_pool().get(_KEY)
        return json.loads(payload) if payload else None
    except Exception:
        logger.warning("Dashboard cache read failed; querying the database", exc_info=True)
        return None


async def set_dashboard_cache(payload: dict[str, Any]) -> None:
    try:
        await get_redis_pool().set(_KEY, json.dumps(payload), ex=_TTL_SECONDS)
    except Exception:
        logger.warning("Dashboard cache write failed", exc_info=True)


async def invalidate_dashboard_cache() -> None:
    try:
        await get_redis_pool().delete(_KEY)
    except Exception:
        logger.warning("Dashboard cache invalidation failed", exc_info=True)
