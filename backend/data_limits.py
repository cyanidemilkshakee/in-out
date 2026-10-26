"""Bound complete reads and charge actual disclosed bytes to verified accounts."""
from __future__ import annotations

import hashlib
import json
import logging

import anyio
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
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

_REFUND_DATA = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if amount <= 0 or used <= 0 then return used end
if amount >= used then
    redis.call('DEL', KEYS[1])
    return 0
end
return redis.call('DECRBY', KEYS[1], amount)
"""

_RECORD_DATA = """
local amount = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local value = redis.call('INCRBY', KEYS[1], amount)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window) end
return value
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


async def refund_data_bytes(identity: str, amount: int) -> None:
    """Release unused precharged bytes without extending their quota window."""
    if amount <= 0:
        return
    key = DATA_KEY_PREFIX + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    try:
        await get_redis_pool().eval(_REFUND_DATA, 1, key, amount)
    except Exception:
        # A refund failure leaves a conservative overcharge. It must not expose
        # database parameters or prevent the already-completed response.
        logger.error("Data quota refund failed", extra={"amount": amount})


async def record_delivered_data_bytes(identity: str, amount: int) -> None:
    """Account bytes that were already committed and therefore cannot be hidden."""
    if amount <= 0:
        return
    key = DATA_KEY_PREFIX + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    try:
        await get_redis_pool().eval(_RECORD_DATA, 1, key, amount, settings.DATA_WINDOW_SECONDS)
    except Exception:
        logger.error("Committed response bytes could not be recorded", extra={"amount": amount})


async def precharge_mutation_bytes(db, amount: int) -> int:
    """Reserve a bounded mutation response before its database commit.

    Callers with a response value should prefer ``precharge_mutation_response``.
    External provider writes whose response is not known until after the write
    can reserve a conservative upper bound; the middleware refunds the unused
    portion after serializing the actual response.
    """
    scope = db.info.get("request_scope")
    state = scope.get("state", {}) if isinstance(scope, dict) else {}
    identity = state.get("limit_identity")
    if not identity or amount <= 0:
        return 0
    if amount > settings.MAX_DATA_RESPONSE_BYTES:
        raise HTTPException(413, "Data response is too large; use a smaller result")
    await consume_data_bytes(identity, amount)
    state["data_response_precharged"] = amount
    return amount


async def precharge_mutation_response(db, body) -> int:
    """Charge a mutation's exact JSON response before its database commit.

    Endpoints call this after constructing the response value and before
    committing. The response guard then verifies and reconciles the actual
    serialized byte count without making an over-quota committed write appear
    to have failed.
    """
    if body is None:
        return 0
    encoded = JSONResponse(content=jsonable_encoder(body)).body
    if len(encoded) > settings.MAX_DATA_RESPONSE_BYTES:
        raise HTTPException(413, "Data response is too large; use a smaller result")
    return await precharge_mutation_bytes(db, len(encoded))


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
        if scope["type"] != "http" or scope.get("method") not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            return await self.app(scope, receive, send)

        start = None
        body = bytearray()
        identity = None
        mode = "pass"
        closed = False
        mutation = scope.get("method") != "GET"
        mutation_started_successfully = False
        mutation_delivered_bytes = 0

        async def settle_mutation_charge(actual_bytes: int | None, *, success: bool) -> None:
            nonlocal identity
            state = scope.get("state", {})
            reserved = state.pop("data_response_precharged", None)
            if not identity:
                return
            if isinstance(reserved, int):
                if not success or actual_bytes is None:
                    await refund_data_bytes(identity, reserved)
                    return
                difference = reserved - actual_bytes
                if difference > 0:
                    await refund_data_bytes(identity, difference)
                elif difference < 0:
                    await record_delivered_data_bytes(identity, -difference)
                return
            if mutation and success and actual_bytes is not None:
                # Guard routes without a precommit hook defensively. Their
                # response is already committed, so send it even if the
                # account has reached its quota and record delivered bytes.
                try:
                    await consume_data_bytes(identity, actual_bytes)
                except HTTPException:
                    logger.error("Mutation response reached the guard without a precommit data charge")
                    await record_delivered_data_bytes(identity, actual_bytes)

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
                nonlocal start, identity, mode, closed, mutation_started_successfully, mutation_delivered_bytes
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
                    elif identity and mutation and success:
                        # Mutation responses are already committed when ASGI
                        # emits headers. Stream them directly and reconcile
                        # the charge by byte count; buffering an oversized
                        # response here could itself exhaust memory.
                        mode = "mutation"
                        start = message
                        mutation_started_successfully = True
                        try:
                            too_large = int(headers.get(b"content-length", b"0")) > settings.MAX_DATA_RESPONSE_BYTES
                        except ValueError:
                            too_large = False
                        if too_large:
                            logger.error("Committed mutation response exceeds the configured size limit")
                        await send(message)
                        return
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
                            if not mutation:
                                return await reject(HTTPException(413,
                                    "Data response is too large; use pagination or a shorter filtered range"))
                            logger.error("Committed mutation response exceeds the configured size limit")
                        return
                    if mutation or isinstance(state.get("data_response_precharged"), int):
                        await settle_mutation_charge(None, success=False)
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

                if mode == "mutation":
                    chunk = message.get("body", b"")
                    await send(message)
                    mutation_delivered_bytes += len(chunk)
                    if not message.get("more_body", False):
                        if mutation_delivered_bytes > settings.MAX_DATA_RESPONSE_BYTES:
                            logger.error("Committed mutation response exceeds the configured size limit")
                        await settle_mutation_charge(mutation_delivered_bytes, success=True)
                        closed = True
                    return

                if len(body) + len(chunk) > settings.MAX_DATA_RESPONSE_BYTES:
                    return await reject(HTTPException(413,
                        "Data response is too large; use pagination or a shorter filtered range"))
                body.extend(chunk)
                if message.get("more_body", False):
                    return
                try:
                    if mutation:
                        await settle_mutation_charge(len(body), success=True)
                    elif isinstance(scope.get("state", {}).get("data_response_precharged"), int):
                        await settle_mutation_charge(len(body), success=True)
                    else:
                        await consume_data_bytes(identity, len(body))
                except HTTPException as error:
                    if mutation:
                        # A mutation has committed by this point. Preserve the
                        # success response and account the bytes so later reads
                        # see the exhausted budget.
                        await record_delivered_data_bytes(identity, len(body))
                    else:
                        return await reject(error)
                await send(start)
                await send({"type": "http.response.body", "body": bytes(body), "more_body": False})
                closed = True

            try:
                await self.app(scope, receive, guarded_send)
            finally:
                if mutation and identity is None:
                    identity = scope.get("state", {}).get("limit_identity")
                if identity:
                    reserved = scope.get("state", {}).get("data_response_precharged")
                    if isinstance(reserved, int):
                        if mutation:
                            await settle_mutation_charge(
                                mutation_delivered_bytes if mutation_started_successfully else None,
                                success=mutation_started_successfully,
                            )
                        else:
                            # GET bodies are buffered until quota admission, so
                            # an incomplete response has disclosed no bytes.
                            await settle_mutation_charge(None, success=False)
                    elif mutation_started_successfully and not closed:
                        await settle_mutation_charge(mutation_delivered_bytes, success=True)
