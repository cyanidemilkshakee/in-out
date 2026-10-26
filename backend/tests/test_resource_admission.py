"""Admission rejects before allocations and recovers resources on termination."""
import asyncio
import os
import sys
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import anyio
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException, Request
from auth import verify_admin_or_operator_request
from config import settings
from request_admission import RequestAdmissionMiddleware
from routers import presence
from redis_client import subscribe_presence
import presence_leases
import redis_client


class ResourceAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_absolute_deadline_shrinks_across_chunks_before_downstream(self):
        elapsed, timeouts, statuses = [0.0], [], []
        app = AsyncMock()
        middleware = RequestAdmissionMiddleware(app)
        async def receive():
            return {"type": "http.request", "body": b"x", "more_body": True}
        async def wait(awaitable, timeout):
            timeouts.append(timeout)
            if timeout < 14:
                awaitable.close()
                raise asyncio.TimeoutError
            elapsed[0] += 14
            return await awaitable
        async def send(message):
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
        scope = {"type": "http", "method": "POST", "path": "/test", "headers": [], "state": {}}
        with patch("request_admission.time.monotonic", side_effect=lambda: elapsed[0]), \
             patch("request_admission.asyncio.wait_for", side_effect=wait):
            await middleware(scope, receive, send)
        self.assertEqual(timeouts, [15, 15, 2])
        self.assertEqual(statuses, [408])
        app.assert_not_awaited()
        self.assertEqual(middleware.active, 0)

    async def test_concurrency_limit_rejects_without_read_or_app_and_recovers_on_cancel(self):
        entered = asyncio.Event()
        async def stalled(scope, receive, send):
            entered.set()
            await asyncio.Event().wait()
        middleware = RequestAdmissionMiddleware(stalled)
        scope = {"type": "http", "method": "GET", "path": "/protected", "headers": []}
        with patch.object(settings, "REQUEST_ADMISSION_CONCURRENCY", 1):
            first = asyncio.create_task(middleware(scope, AsyncMock(), AsyncMock()))
            await entered.wait()
            receive, send = AsyncMock(), AsyncMock()
            await middleware(scope, receive, send)
            receive.assert_not_awaited()
            self.assertEqual(send.await_args_list[0].args[0]["status"], 503)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
        self.assertEqual(middleware.active, 0)

    async def test_stream_rejection_precedes_assignment_and_pubsub(self):
        app = FastAPI()
        app.include_router(presence.router)
        claims = {"sub": "operator", "exp": time.time() + 300}
        app.dependency_overrides[verify_admin_or_operator_request] = lambda: claims
        with patch("routers.presence.acquire_stream_lease", new=AsyncMock(side_effect=HTTPException(429, "limit"))), \
             patch("routers.presence._current_checkpoint", new=AsyncMock()) as checkpoint, \
             patch("routers.presence.subscribe_presence") as subscribe:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://isolated") as client:
                response = await client.get("/v1/presence/stream")
        self.assertEqual(response.status_code, 429)
        checkpoint.assert_not_awaited()
        subscribe.assert_not_called()

    async def test_disconnect_closes_subscription_and_releases_lease(self):
        started, closed = asyncio.Event(), []
        async def subscription():
            try:
                started.set()
                await asyncio.Event().wait()
                yield None
            finally:
                closed.append(True)
        async def receive():
            await started.wait()
            return {"type": "http.disconnect"}
        scope = {"type": "http", "method": "GET", "path": "/stream", "headers": [], "asgi": {"spec_version": "2.0"}}
        claims = {"sub": "admin", "exp": time.time() + 300, "realm_access": {"roles": ["admin"]}}
        lease = SimpleNamespace(expires_at=claims["exp"])
        with patch("routers.presence.acquire_stream_lease", new=AsyncMock(return_value=lease)), \
             patch("routers.presence.release_stream_lease", new=AsyncMock()) as release, \
             patch("routers.presence.renew_stream_lease", new=AsyncMock(return_value=True)), \
             patch("routers.presence.subscribe_presence", subscription):
            response = await presence.stream_presence(Request(scope), claims)
            await response(scope, receive, AsyncMock())
        self.assertEqual(closed, [True])
        release.assert_awaited_once_with(lease)

    async def test_response_send_failure_releases_lease(self):
        scope = {"type": "http", "method": "GET", "headers": [], "asgi": {"spec_version": "2.4"}}
        claims = {"sub": "admin", "exp": time.time() + 300, "realm_access": {"roles": ["admin"]}}
        lease = SimpleNamespace(expires_at=claims["exp"])
        closed, sent = [], []
        async def subscription():
            try:
                yield None
                await asyncio.Event().wait()
            finally:
                closed.append(True)
        async def send(message):
            if message["type"] == "http.response.body":
                sent.append(message["body"])
                self.assertEqual(message["body"], b": heartbeat\n\n")
                raise RuntimeError("send failure")
        with patch("routers.presence.acquire_stream_lease", new=AsyncMock(return_value=lease)), \
             patch("routers.presence.release_stream_lease", new=AsyncMock()) as release, \
             patch("routers.presence.renew_stream_lease", new=AsyncMock(return_value=True)), \
             patch("routers.presence.subscribe_presence", subscription):
            response = await presence.stream_presence(Request(scope, receive=AsyncMock(return_value={"type": "http.request"})), claims)
            with self.assertRaises(Exception):
                await response(scope, AsyncMock(return_value={"type": "http.request"}), send)
        self.assertEqual(sent, [b": heartbeat\n\n"])
        self.assertEqual(closed, [True])
        release.assert_awaited_once_with(lease)

    async def test_lease_watchdog_closes_backpressured_stream_on_lost_lease(self):
        blocked, closed = asyncio.Event(), []
        async def subscription():
            try:
                yield None
            finally:
                closed.append(True)
        async def send(message):
            if message["type"] == "http.response.body":
                blocked.set()
                await asyncio.Event().wait()
        async def next_renewal(_seconds):
            await blocked.wait()
        scope = {"type": "http", "method": "GET", "headers": [], "asgi": {"spec_version": "2.4"}}
        claims = {"sub": "admin", "exp": time.time() + 300, "realm_access": {"roles": ["admin"]}}
        lease = SimpleNamespace(expires_at=claims["exp"])
        request = Request(scope, receive=AsyncMock(return_value={"type": "http.request"}))
        with patch("routers.presence.acquire_stream_lease", new=AsyncMock(return_value=lease)), \
             patch("routers.presence.release_stream_lease", new=AsyncMock()) as release, \
             patch("routers.presence.renew_stream_lease", new=AsyncMock(side_effect=[True, False])) as renew, \
             patch("routers.presence.subscribe_presence", subscription), \
             patch("routers.presence.anyio.sleep", next_renewal):
            response = await presence.stream_presence(request, claims)
            await asyncio.wait_for(response(scope, AsyncMock(), send), timeout=1)
        self.assertEqual(renew.await_count, 2)
        self.assertEqual(closed, [True])
        release.assert_awaited_once_with(lease)

    async def test_subscribe_failure_still_closes_pubsub(self):
        pubsub = Mock(subscribe=AsyncMock(side_effect=RuntimeError("subscription failure")),
                      unsubscribe=AsyncMock(side_effect=RuntimeError("unsubscribe failure")), aclose=AsyncMock())
        with patch("redis_client.get_events_pool", return_value=Mock(pubsub=lambda: pubsub)):
            with self.assertRaises(RuntimeError):
                await anext(subscribe_presence())
        pubsub.aclose.assert_awaited_once()

    async def test_quota_and_events_use_separate_bounded_clients_and_close_both(self):
        quota, events = Mock(aclose=AsyncMock()), Mock(aclose=AsyncMock())
        loop = asyncio.get_running_loop()
        with patch("redis_client._redis_pool", None), patch("redis_client._redis_loop", None), \
             patch("redis_client._events_pool", None), patch("redis_client._events_loop", None), \
             patch.object(settings, "QUOTA_REDIS_URL", "redis://quota.invalid/0"), \
             patch.object(settings, "EVENTS_REDIS_URL", "redis://events.invalid/0"), \
             patch("redis_client.aioredis.from_url", side_effect=[quota, events]) as create:
            self.assertIs(redis_client.get_redis_pool(), quota)
            self.assertIs(redis_client.get_events_pool(), events)
            self.assertIs(redis_client._redis_loop, loop)
            self.assertEqual(create.call_args_list[0].args[0], "redis://quota.invalid/0")
            self.assertEqual(create.call_args_list[1].args[0], "redis://events.invalid/0")
            self.assertEqual(create.call_args_list[0].kwargs["max_connections"], settings.QUOTA_REDIS_MAX_CONNECTIONS)
            self.assertEqual(create.call_args_list[1].kwargs["max_connections"], settings.EVENTS_REDIS_MAX_CONNECTIONS)
            await redis_client.close_redis_pool()
        quota.aclose.assert_awaited_once()
        events.aclose.assert_awaited_once()

    async def test_lease_release_survives_request_cancel_scope(self):
        completed = []
        async def release(*_args):
            await anyio.sleep(0)
            completed.append(True)
        lease = presence_leases.StreamLease("id", "principal-key", time.time() + 300)
        with patch("presence_leases.get_redis_pool", return_value=Mock(eval=AsyncMock(side_effect=release))):
            with anyio.CancelScope() as scope:
                scope.cancel()
                await presence_leases.release_stream_lease(lease)
        self.assertEqual(completed, [True])


@unittest.skipUnless(os.getenv("TEST_REDIS_URL"), "Isolated Redis required")
class DistributedLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ["TEST_REDIS_URL"]
        if urlparse(url).hostname != "redis-test":
            raise RuntimeError("Requires isolated redis-test")
        self.client = redis.from_url(url, decode_responses=True)
        self.prefix = "inout:presence-lease:{test-" + uuid.uuid4().hex + "}:"
        self.patches = [patch("presence_leases.get_redis_pool", return_value=self.client),
            patch("presence_leases.LEASE_PREFIX", self.prefix),
            patch.object(settings, "PRESENCE_STREAMS_PER_PRINCIPAL", 1),
            patch.object(settings, "PRESENCE_STREAMS_GLOBAL", 2)]
        for item in self.patches:
            item.start()
        self.claims = lambda name: {"sub": name, "exp": time.time() + 300}

    async def asyncTearDown(self):
        keys = [key async for key in self.client.scan_iter(self.prefix + "*")]
        if keys:
            await self.client.delete(*keys)
        for item in reversed(self.patches):
            item.stop()
        await self.client.aclose()

    async def test_concurrent_replicas_enforce_principal_global_caps_and_release(self):
        results = await asyncio.gather(*[presence_leases.acquire_stream_lease(self.claims("alice")) for _ in range(6)], return_exceptions=True)
        leases = [value for value in results if isinstance(value, presence_leases.StreamLease)]
        self.assertEqual(len(leases), 1)
        self.assertTrue(all(value.status_code == 429 for value in results if isinstance(value, HTTPException)))
        bob = await presence_leases.acquire_stream_lease(self.claims("bob"))
        with self.assertRaises(HTTPException) as denied:
            await presence_leases.acquire_stream_lease(self.claims("carol"))
        self.assertEqual(denied.exception.status_code, 429)
        self.assertTrue(await presence_leases.renew_stream_lease(bob))
        await presence_leases.release_stream_lease(bob)
        carol = await presence_leases.acquire_stream_lease(self.claims("carol"))
        await presence_leases.release_stream_lease(carol)
        self.assertEqual(await self.client.zcard(leases[0].keys[0]), 1)

    async def test_expired_dead_worker_lease_is_recovered_and_never_resurrected(self):
        lease = await presence_leases.acquire_stream_lease(self.claims("alice"))
        for key in lease.keys:
            await self.client.zadd(key, {lease.id: time.time() - 1})
        self.assertFalse(await presence_leases.renew_stream_lease(lease))
        replacement = await presence_leases.acquire_stream_lease(self.claims("alice"))
        self.assertNotEqual(replacement.id, lease.id)
        self.assertLessEqual(await self.client.ttl(replacement.keys[0]), settings.PRESENCE_LEASE_SECONDS + 1)
