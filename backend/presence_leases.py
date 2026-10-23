"""Atomic, expiring stream admission shared by API replicas."""
import hashlib
import logging
import uuid
from dataclasses import dataclass

import anyio
from fastapi import HTTPException
from config import settings
from redis_client import get_redis_pool

logger = logging.getLogger(__name__)
LEASE_PREFIX = "inout:presence-lease:{streams}:"
_ADMIT = """
local now = tonumber(redis.call('TIME')[1])
local expiry = math.min(now + tonumber(ARGV[2]), tonumber(ARGV[3]))
for _, key in ipairs(KEYS) do redis.call('ZREMRANGEBYSCORE', key, '-inf', now) end
if expiry <= now or redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4])
    or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
for _, key in ipairs(KEYS) do
    redis.call('ZADD', key, expiry, ARGV[1])
    redis.call('EXPIRE', key, tonumber(ARGV[2]) + 1)
end
return 1
"""
_RENEW = """
local now = tonumber(redis.call('TIME')[1])
local expiry = math.min(now + tonumber(ARGV[2]), tonumber(ARGV[3]))
for _, key in ipairs(KEYS) do
    local saved = tonumber(redis.call('ZSCORE', key, ARGV[1]) or '0')
    if saved <= now or expiry <= now then return 0 end
end
for _, key in ipairs(KEYS) do
    redis.call('ZADD', key, expiry, ARGV[1])
    redis.call('EXPIRE', key, tonumber(ARGV[2]) + 1)
end
return 1
"""
_RELEASE = """
for _, key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end
return 1
"""


@dataclass(frozen=True)
class StreamLease:
    id: str
    principal_key: str
    expires_at: float

    @property
    def keys(self):
        return (LEASE_PREFIX + "global", self.principal_key)


async def acquire_stream_lease(claims):
    identity = settings.KEYCLOAK_ISSUER + ":" + claims["sub"]
    lease = StreamLease(uuid.uuid4().hex,
        LEASE_PREFIX + "principal:" + hashlib.sha256(identity.encode()).hexdigest(), float(claims["exp"]))
    try:
        admitted = await get_redis_pool().eval(_ADMIT, 2, *lease.keys,
            lease.id, settings.PRESENCE_LEASE_SECONDS, lease.expires_at,
            settings.PRESENCE_STREAMS_GLOBAL, settings.PRESENCE_STREAMS_PER_PRINCIPAL)
    except Exception as exc:
        raise HTTPException(503, "Stream admission is temporarily unavailable") from exc
    if not admitted:
        raise HTTPException(429, "Active stream limit reached", headers={"Retry-After": "15"})
    return lease


async def renew_stream_lease(lease):
    return bool(await get_redis_pool().eval(_RENEW, 2, *lease.keys,
        lease.id, settings.PRESENCE_LEASE_SECONDS, lease.expires_at))


async def release_stream_lease(lease):
    # Shield cancellation while releasing; Redis socket timeouts bound cleanup.
    # A dead process/store still recovers automatically through lease expiry.
    with anyio.CancelScope(shield=True):
        try:
            await get_redis_pool().eval(_RELEASE, 2, *lease.keys, lease.id)
        except Exception:
            logger.exception("Stream lease cleanup deferred to expiry")
