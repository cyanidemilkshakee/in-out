"""Bound complete reads and charge actual disclosed bytes to verified accounts."""
from __future__ import annotations

import hashlib
import json
import logging

import anyio
from fastapi import HTTPException
from starlette.responses import JSONResponse

from config import settings
from redis_client import get_redis_pool
from api_errors import error_body

logger = logging.getLogger(__name__)
DATA_KEY_PREFIX = "inout:security-limits:data:principal:"

# The check and debit share one Redis operation across every API replica.
# Rejections never extend the window or consume bytes from the next response.
_CONSUME_DATA = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then ttl = window end
if used + amount > maximum then return {0, ttl} end
if amount > 0 then
    redis.call('INCRBY', KEYS[1], amount)
    if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window) end
end
return {1, ttl}
"""


async def record_limit_event(scope, kind, retry_after, details):
    # Keep this helper importable in isolated tests as well as worker tooling.
    # The event recorder is shared with request/behavior limiting by the API.
    from limit_events import record_limit_event as record
    await record(scope, kind, retry_after, details)


async def consume_data_bytes(identity: str, amount: int) -> None:
    """Identity must come from verified request state, never a browser header."""
    if amount <= 0:
        return
    key = DATA_KEY_PREFIX + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    try:
        admitted, ttl = await get_redis_pool().eval(_CONSUME_DATA, 1, key, amount,
            settings.DATA_BYTES_PER_MINUTE, settings.DATA_WINDOW_SECONDS)
    except Exception as error:
        logger.exception("Data quota store unavailable")
        raise HTTPException(503, "Data delivery is temporarily unavailable",
                            headers={"Retry-After": "5"}) from error
    if not int(admitted):
        retry_after = max(1, int(ttl))
        raise HTTPException(429, f"Data download limit reached. Try again in {retry_after} seconds",
                            headers={"Retry-After": str(retry_after)})


async def bounded_rows(db, stmt, maximum=None):
    """Fetch one extra row to reject incomplete snapshots before serialization."""
    maximum = settings.DATA_SNAPSHOT_MAX_ROWS if maximum is None else maximum
    rows = (await db.execute(stmt.limit(maximum + 1))).all()
    if len(rows) > maximum:
        raise HTTPException(422, "Too many records for one complete read; use pagination or a shorter filtered range")
    return rows


class DataLimitsMiddleware:
    """Hold complete JSON reads; debit SSE chunks without buffering the stream."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "GET":
            return await self.app(scope, receive, send)

        start = None
        body = bytearray()
        identity = None
        mode = "pass"
        closed = False

        # Canceling the request stops the upstream streaming iterator. Its
        # shielded finally blocks still release pubsub resources and leases.
        with anyio.CancelScope() as request_scope:
            async def reject(error, *, stream=False):
                nonlocal closed
                closed = True
                retry_after = max(1, int((error.headers or {}).get("Retry-After", "60")))
                kind = "data_response_size" if error.status_code == 413 else "data_delivery"
                try:
                    await record_limit_event(scope, kind, retry_after,
                        {"status": error.status_code, "stream": stream})
                except Exception:
                    logger.exception("Unable to record data limit event")
                if stream:
                    payload = json.dumps({"type": "throttled", **error_body(error.status_code, error.detail),
                                          "retryAfter": retry_after}, separators=(",", ":"))
                    await send({"type": "http.response.body", "body":
                        f"event: throttled\nretry: {retry_after * 1000}\ndata: {payload}\n\n".encode(),
                        "more_body": False})
                else:
                    await JSONResponse(error_body(error.status_code, error.detail), error.status_code,
                                       headers=error.headers)(scope, receive, send)
                request_scope.cancel()

            async def guarded_send(message):
                nonlocal start, identity, mode, closed
                if closed:
                    # A cancellation checkpoint is required even if an ASGI
                    # application keeps invoking send without other awaits.
                    await anyio.lowlevel.checkpoint()
                    return
                if message["type"] == "http.response.start":
                    state = scope.get("state", {})
                    identity = state.get("limit_identity")
                    headers = {key.lower(): value for key, value in message.get("headers", [])}
                    content_type = headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower()
                    success = 200 <= message["status"] < 300
                    if identity and success and content_type == b"text/event-stream":
                        mode = "stream"
                    elif identity and success and (content_type == b"application/json" or content_type.endswith(b"+json")):
                        mode = "json"
                        start = message
                        # A declared size is an early rejection, never a quota
                        # charge. Chunk lengths remain the actual byte measure.
                        try:
                            too_large = int(headers.get(b"content-length", b"0")) > settings.MAX_DATA_RESPONSE_BYTES
                        except ValueError:
                            too_large = False
                        if too_large:
                            return await reject(HTTPException(413,
                                "Data response is too large; use pagination or a shorter filtered range"))
                        return
                    return await send(message)
                if message["type"] != "http.response.body" or mode == "pass":
                    return await send(message)

                chunk = message.get("body", b"")
                if mode == "stream":
                    if len(chunk) > settings.MAX_DATA_RESPONSE_BYTES:
                        return await reject(HTTPException(413,
                            "A live update is too large; reload using a filtered view"), stream=True)
                    try:
                        await consume_data_bytes(identity, len(chunk))
                    except HTTPException as error:
                        return await reject(error, stream=True)
                    return await send(message)

                if len(body) + len(chunk) > settings.MAX_DATA_RESPONSE_BYTES:
                    return await reject(HTTPException(413,
                        "Data response is too large; use pagination or a shorter filtered range"))
                body.extend(chunk)
                if message.get("more_body", False):
                    return
                try:
                    await consume_data_bytes(identity, len(body))
                except HTTPException as error:
                    return await reject(error)
                await send(start)
                await send({"type": "http.response.body", "body": bytes(body), "more_body": False})
                closed = True

            await self.app(scope, receive, guarded_send)
