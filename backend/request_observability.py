"""Bounded request correlation and payload-free JSON completion logs."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import json
import logging
import time
import uuid

from database import is_database_timeout

logger = logging.getLogger("inout.requests")
request_id_context: ContextVar[str | None] = ContextVar("request_id", default=None)
_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})


def configure_request_logging() -> None:
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def _request_id(headers) -> str:
    candidates = [value for key, value in headers if key.lower() == b"x-request-id"]
    if len(candidates) == 1 and len(candidates[0]) == 36:
        try:
            value = candidates[0].decode("ascii")
            normalized = str(uuid.UUID(value))
            if normalized == value.lower():
                return normalized
        except (ValueError, UnicodeDecodeError):
            pass
    return str(uuid.uuid4())


class RequestObservabilityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = _request_id(scope.get("headers", []))
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_context.set(request_id)
        started = time.monotonic()
        status, headers_ms, outcome = 500, None, "completed"

        async def traced_send(message):
            nonlocal status, headers_ms
            if message["type"] == "http.response.start":
                status = message["status"]
                headers_ms = round((time.monotonic() - started) * 1000, 2)
                headers = [(key, value) for key, value in message.get("headers", [])
                           if key.lower() != b"x-request-id"]
                message = {**message, "headers": [*headers, (b"x-request-id", request_id.encode("ascii"))]}
            await send(message)

        try:
            return await self.app(scope, receive, traced_send)
        except asyncio.CancelledError:
            outcome = "cancelled"
            if headers_ms is None:
                status = 499
            raise
        except Exception as error:
            # ServerErrorMiddleware applies the outer error handler after this
            # middleware unwinds. Match its safe dependency-timeout response.
            if headers_ms is None and is_database_timeout(error):
                status = 503
            outcome = "failed"
            raise
        finally:
            route = scope.get("route")
            logger.info(json.dumps({
                "event": "http_request", "request_id": request_id,
                "method": scope.get("method") if scope.get("method") in _METHODS else "OTHER",
                "route": getattr(route, "path", "<unmatched>"),
                "status": status, "outcome": outcome, "headers_ms": headers_ms,
                "duration_ms": round((time.monotonic() - started) * 1000, 2),
            }, separators=(",", ":")))
            request_id_context.reset(token)
