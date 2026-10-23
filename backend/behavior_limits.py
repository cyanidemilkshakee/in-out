"""Actor-local abuse detection and temporary write cooldowns.

Every Redis script uses Redis time and one identity hash slot. Rejected work
does not enter a sliding window or extend the actor's existing cooldown.
"""
import hashlib
import logging
import uuid

from fastapi import HTTPException

from config import settings
from redis_client import get_redis_pool

logger = logging.getLogger(__name__)
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
FAILURE_STATUSES = frozenset({400, 403, 409, 422})

_COOLDOWN_CHECK = """
local cooling = redis.call('PTTL', KEYS[1])
if cooling > 0 then return {0, math.ceil(cooling / 1000), 0} end
return {1, 0, 0}
"""

_FAILURE_RECORD = """
local cooling = redis.call('PTTL', KEYS[1])
if cooling > 0 then return {0, math.ceil(cooling / 1000), 0} end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 60000)
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('EXPIRE', KEYS[2], 60)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then
    redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
    return {0, tonumber(ARGV[2]), 1}
end
return {1, 0, 0}
"""

_UNKNOWN_ADMISSION = """
local cooling = redis.call('PTTL', KEYS[1])
if cooling > 0 then return {0, math.ceil(cooling / 1000), 0} end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 60000)
if redis.call('ZSCORE', KEYS[2], ARGV[3]) then return {1, 0, 0} end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then
    redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
    return {0, tonumber(ARGV[2]), 1}
end
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('EXPIRE', KEYS[2], 60)
return {1, 0, 0}
"""


def _scope(request):
    return request.scope if hasattr(request, "scope") else request


def _keys(identity):
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    # Braces co-locate all of one actor's keys when deployed on Redis Cluster.
    return "inout:security-limits:behavior:{" + digest + "}"


async def _eval(script, keys, *arguments):
    try:
        return await get_redis_pool().eval(script, len(keys), *keys, *arguments)
    except Exception as exc:
        logger.exception("Behavior limit store unavailable")
        raise HTTPException(503, "Behavior limiting is temporarily unavailable") from exc


async def _event(scope, kind, retry_after, details):
    if scope is None:
        return
    from limit_events import record_limit_event
    await record_limit_event(scope, kind, retry_after, details)


async def _reject_if_needed(scope, outcome, kind, details):
    admitted, ttl, first = (int(value) for value in outcome)
    if admitted:
        return
    retry_after = max(1, ttl)
    if first:
        await _event(scope, kind, retry_after, details)
    raise HTTPException(429, f"Unusual activity limit reached. Try again in {retry_after} seconds.",
                        headers={"Retry-After": str(retry_after)})


async def enforce_behavior_admission(request, identity):
    """Honor a cooldown caused by failed requests or unknown-barcode probing.

    Identity must have been established by JWT or trusted mTLS validation.
    Reading review context remains possible while the actor is cooling down.
    Successful request frequency is limited by Kong, not this check.
    """
    if request is None:
        return
    scope = _scope(request)
    if scope.get("method") not in WRITE_METHODS:
        return
    # A cooldown must not prevent an administrator revoking their unlocked
    # user-management window. This operation only removes authorization.
    if scope.get("method") == "POST" and scope.get("path", "").rstrip("/") == "/v1/user-management/lock":
        return
    state = scope.setdefault("state", {})
    if state.get("behavior_admitted"):
        return
    state["behavior_admitted"] = True
    base = _keys(identity)
    outcome = await _eval(_COOLDOWN_CHECK, [base + ":cooldown"])
    await _reject_if_needed(scope, outcome, "behavior", {"signal": "active_cooldown"})


async def record_behavior_failure(scope, status):
    """Count authenticated validation/access failures without changing response.

    Denied scan decisions return 200 and are intentionally outside this signal.
    The request that reaches the threshold retains its original error; later
    writes receive 429 for the temporary cooldown.
    """
    if status not in FAILURE_STATUSES or scope is None:
        return
    scope = _scope(scope)
    state = scope.setdefault("state", {})
    identity = state.get("limit_identity")
    if not identity or state.get("behavior_failure_recorded"):
        return
    state["behavior_failure_recorded"] = True
    base = _keys(identity)
    outcome = await _eval(_FAILURE_RECORD, [base + ":cooldown", base + ":failures"],
        settings.BEHAVIOR_FAILURES_PER_MINUTE, settings.BEHAVIOR_COOLDOWN_SECONDS,
        uuid.uuid4().hex)
    if int(outcome[2]):
        await _event(scope, "behavior", max(1, int(outcome[1])),
                     {"signal": "repeated_validation_failures", "status": status})


async def consume_unknown_barcode_quota(identity, barcode, scope=None):
    """Count distinct fresh unknown barcodes, never replay receipts or subjects."""
    scope = _scope(scope) if scope is not None else None
    base = _keys(identity)
    digest = hashlib.sha256(barcode.strip().casefold().encode("utf-8")).hexdigest()
    outcome = await _eval(_UNKNOWN_ADMISSION, [base + ":cooldown", base + ":unknown"],
        settings.BEHAVIOR_UNKNOWN_BARCODES_PER_MINUTE, settings.BEHAVIOR_COOLDOWN_SECONDS,
        digest)
    await _reject_if_needed(scope, outcome, "behavior", {"signal": "unknown_barcode_enumeration"})
