"""Bound request resources; request-frequency limits are enforced by Kong."""
import asyncio
import logging
import time

from fastapi import HTTPException
from starlette.responses import JSONResponse

from config import settings
from behavior_limits import record_behavior_failure
from api_errors import error_body

logger = logging.getLogger(__name__)
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

class RequestAdmissionMiddleware:
    def __init__(self, app):
        self.app = app
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") == "/health/live":
            return await self.app(scope, receive, send)
        # Event-loop-local admission has no wait queue. It bounds body readers
        # and application/authentication work through final response delivery.
        # Long-lived streams release at their headers and use distributed leases.
        if self.active >= settings.REQUEST_ADMISSION_CONCURRENCY:
            detail = "Request capacity exhausted"
            return await JSONResponse(error_body(503, detail), 503,
                                      headers={"Retry-After": "1"})(scope, receive, send)
        self.active += 1
        released = False

        def release():
            nonlocal released
            if not released:
                self.active -= 1
                released = True

        async def admitted_send(message):
            if message["type"] == "http.response.start":
                try:
                    await record_behavior_failure(scope, message["status"])
                except HTTPException:
                    # Recording a failed request must not replace its rejection
                    # or turn a completed response into an ASGI exception.
                    logger.warning("Behavior failure recording unavailable")
                headers = {key.lower(): value for key, value in message.get("headers", [])}
                if headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() == b"text/event-stream":
                    release()
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                release()

        try:
            return await self._admitted(scope, receive, admitted_send)
        finally:
            release()

    async def _admitted(self, scope, receive, send):
        if scope["method"] not in WRITE_METHODS:
            return await self.app(scope, receive, send)

        async def reject(status, detail):
            await JSONResponse(error_body(status, detail), status_code=status)(scope, receive, send)

        body = bytearray()
        deadline = time.monotonic() + settings.REQUEST_BODY_DEADLINE_SECONDS
        while True:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return await reject(408, "Request body timed out")
                message = await asyncio.wait_for(receive(), timeout=min(15, remaining))
            except asyncio.TimeoutError:
                return await reject(408, "Request body timed out")
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > settings.MAX_REQUEST_BODY_BYTES:
                return await reject(413, "Request payload is too large")
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, bounded_receive, send)
