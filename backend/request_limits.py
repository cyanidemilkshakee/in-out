"""Bound write requests even when callers omit Content-Length."""
from collections import OrderedDict, deque
from time import monotonic
import asyncio

from starlette.responses import JSONResponse
from config import settings


class RequestLimitsMiddleware:
    def __init__(self, app):
        self.app = app
        self.windows = OrderedDict()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH", "DELETE"}:
            return await self.app(scope, receive, send)

        async def reject(status, detail):
            await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)

        now = monotonic()
        # LRU ordering and a hard cap bound memory even for many source IPs.
        while self.windows:
            key, values = next(iter(self.windows.items()))
            if values and now - values[-1] < 60:
                break
            self.windows.pop(key)
        client = (scope.get("client") or ("unknown", 0))[0]
        window = self.windows.setdefault(client, deque())
        self.windows.move_to_end(client)
        while len(self.windows) > 10000:
            self.windows.popitem(last=False)
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= settings.WRITE_RATE_LIMIT_PER_MINUTE:
            return await reject(429, "Too many write requests; try again shortly")
        window.append(now)

        body = bytearray()
        while True:
            try:
                message = await asyncio.wait_for(receive(), timeout=15)
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
