"""Data disclosure quotas; isolated ASGI fixtures and an opt-in test Redis."""
import asyncio
import hashlib
import os
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import redis.asyncio as aioredis
from fastapi import HTTPException
from sqlalchemy import literal, select
from starlette.responses import JSONResponse, Response

import data_limits
from data_limits import DataLimitsMiddleware, bounded_rows, consume_data_bytes, precharge_mutation_response


class FakeRedis:
    def __init__(self):
        self.used = {}

    async def eval(self, script, numkeys, key, amount, maximum, window):
        used = self.used.get(key, 0)
        if used + int(amount) > int(maximum):
            return [0, 42]
        self.used[key] = used + int(amount)
        return [1, 42]


def fixture_app(*, status=200, response=None, authenticate=True):
    async def app(scope, receive, send):
        if authenticate:
            # Stand-in for the verified authentication dependency. Incoming
            # forwarded addresses, Authorization and identity headers are ignored.
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
        await (response or JSONResponse({"rows": ["complete"]}, status))(scope, receive, send)
    return DataLimitsMiddleware(app)


class DataLimitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.redis = FakeRedis()
        self.config = SimpleNamespace(DATA_BYTES_PER_MINUTE=64 * 1024 * 1024,
            DATA_WINDOW_SECONDS=60, MAX_DATA_RESPONSE_BYTES=16 * 1024 * 1024,
            DATA_SNAPSHOT_MAX_ROWS=10_000)
        self.events = AsyncMock()
        for patcher in (patch("data_limits.get_redis_pool", return_value=self.redis),
                        patch("data_limits.settings", self.config),
                        patch("data_limits.record_limit_event", self.events)):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def request(self, app=None, method="GET", **kwargs):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app or fixture_app()),
                                     base_url="http://isolated") as client:
            return await client.request(method, "/data", **kwargs)

    async def test_complete_json_is_charged_by_actual_bytes_once(self):
        response = await self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(sum(self.redis.used.values()), len(response.content))
        self.assertEqual(response.json(), {"rows": ["complete"]})

    async def test_shared_identity_budget_rejects_without_debit_or_data_leak(self):
        self.config.DATA_BYTES_PER_MINUTE = 41
        first = await self.request()
        self.assertEqual(first.status_code, 200)
        used = dict(self.redis.used)
        blocked = await self.request(fixture_app(), headers={"Authorization": "Bearer rotated-token",
                                                            "X-Forwarded-For": "203.0.113.7"})
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.headers["retry-after"], "42")
        self.assertNotIn("complete", blocked.text)
        self.assertEqual(self.redis.used, used)
        self.events.assert_awaited_once()

    async def test_failed_unverified_head_and_non_json_reads_do_not_debit(self):
        self.assertEqual((await self.request(fixture_app(status=403))).status_code, 403)
        self.assertEqual((await self.request(fixture_app(authenticate=False), headers={"X-Limit-Identity": "alice"})).status_code, 200)
        self.assertEqual((await self.request(method="HEAD")).status_code, 200)
        self.assertEqual((await self.request(fixture_app(response=Response("public text")))).status_code, 200)
        self.assertEqual(self.redis.used, {})

    async def test_mutation_is_rejected_before_commit_when_response_bytes_exceed_quota(self):
        self.config.DATA_BYTES_PER_MINUTE = 1
        commits = []
        payload = {"changed": True, "value": "private result"}
        async def mutating_app(scope, receive, send):
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
            db = SimpleNamespace(info={"request_scope": scope})
            try:
                await precharge_mutation_response(db, payload)
            except HTTPException as error:
                await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
                return
            commits.append(True)
            await JSONResponse(payload)(scope, receive, send)
        response = await self.request(DataLimitsMiddleware(mutating_app), method="POST")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(commits, [])
        self.assertEqual(self.redis.used, {})

        self.config.DATA_BYTES_PER_MINUTE = 1024
        success = await self.request(DataLimitsMiddleware(mutating_app), method="POST")
        self.assertEqual(success.status_code, 200)
        self.assertEqual(commits, [True])
        self.assertEqual(sum(self.redis.used.values()), len(success.content))

    async def test_oversized_committed_mutation_streams_chunks_and_accounts_bytes(self):
        self.config.MAX_DATA_RESPONSE_BYTES = 4
        forwarded = []
        chunks = [b'{"a":', b'1}']

        async def app(scope, receive, send):
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
            await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": chunks[0], "more_body": True})
            # The first chunk reaches the client before the application emits
            # the rest, proving this committed response is not buffered.
            self.assertEqual(forwarded[-1]["body"], chunks[0])
            await send({"type": "http.response.body", "body": chunks[1], "more_body": False})

        scope = {"type": "http", "method": "POST", "path": "/mutation", "headers": []}
        await DataLimitsMiddleware(app)(scope, AsyncMock(return_value={"type": "http.request"}),
            AsyncMock(side_effect=lambda message: forwarded.append(message)))
        self.assertEqual([message["type"] for message in forwarded], [
            "http.response.start", "http.response.body", "http.response.body"])
        self.assertEqual([message.get("body") for message in forwarded[1:]], chunks)
        self.assertEqual(sum(self.redis.used.values()), sum(map(len, chunks)))

    async def test_declared_oversized_response_rejected_before_headers(self):
        self.config.MAX_DATA_RESPONSE_BYTES = 10
        response = await self.request()
        self.assertEqual(response.status_code, 413)
        self.assertNotIn("complete", response.text)
        self.assertEqual(self.redis.used, {})

    async def test_chunked_response_is_complete_or_rejected_never_truncated(self):
        cleanup = []
        async def app(scope, receive, send):
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
            try:
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"rows":', "more_body": True})
                await send({"type": "http.response.body", "body": b'[1,2,3]}', "more_body": False})
            finally:
                cleanup.append(True)
        response = await self.request(DataLimitsMiddleware(app))
        self.assertEqual(response.json(), {"rows": [1, 2, 3]})
        self.assertEqual(sum(self.redis.used.values()), len(response.content))
        self.redis.used.clear()
        self.config.MAX_DATA_RESPONSE_BYTES = 10
        blocked = await self.request(DataLimitsMiddleware(app))
        self.assertEqual(blocked.status_code, 413)
        self.assertNotIn('"rows"', blocked.text)
        self.assertEqual(self.redis.used, {})
        self.assertEqual(cleanup, [True, True])

    async def test_json_quota_outage_fails_closed(self):
        with patch("data_limits.get_redis_pool", side_effect=RuntimeError("isolated outage")), \
             self.assertLogs("data_limits", level="ERROR"):
            response = await self.request()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["retry-after"], "5")
        self.assertNotIn("complete", response.text)

    async def test_json_suffix_content_type_is_protected(self):
        self.config.DATA_BYTES_PER_MINUTE = 1
        response = await self.request(fixture_app(response=Response(b'{"private":true}', media_type="application/problem+json")))
        self.assertEqual(response.status_code, 429)

    async def test_bounded_rows_fetches_one_extra_and_refuses_incomplete_snapshot(self):
        statement = select(literal(1))
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(1,), (2,), (3,)])))
        with self.assertRaises(HTTPException) as context:
            await bounded_rows(db, statement, 2)
        self.assertEqual(context.exception.status_code, 422)
        self.assertEqual(db.execute.call_args.args[0]._limit_clause.value, 3)
        db.execute.return_value = SimpleNamespace(all=lambda: [(1,), (2,)])
        self.assertEqual(await bounded_rows(db, statement, 2), [(1,), (2,)])

    async def test_sse_limit_closes_iterator_and_releases_lease(self):
        from routers.presence import LeasedStreamingResponse
        self.config.DATA_BYTES_PER_MINUTE = 20
        closed, messages = [], []
        async def events():
            try:
                yield b"data: first\n\n"
                yield b"data: private-second\n\n"
                yield b"data: never-sent\n\n"
            finally:
                closed.append(True)
        async def app(scope, receive, send):
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
            await LeasedStreamingResponse(events(), lease="fixture-lease",
                media_type="text/event-stream")(scope, receive, send)
        scope = {"type": "http", "method": "GET", "path": "/stream", "headers": [],
                 "asgi": {"spec_version": "2.4"}}
        with patch("routers.presence.release_stream_lease", new=AsyncMock()) as release, \
             patch("routers.presence.renew_stream_lease", new=AsyncMock(return_value=True)):
            await DataLimitsMiddleware(app)(scope, AsyncMock(return_value={"type": "http.request"}),
                AsyncMock(side_effect=lambda message: messages.append(message)))
        self.assertEqual(closed, [True])
        release.assert_awaited_once_with("fixture-lease")
        body = b"".join(message.get("body", b"") for message in messages)
        self.assertIn(b"data: first", body)
        self.assertIn(b"event: throttled", body)
        self.assertIn(b"retry: 42000", body)
        self.assertNotIn(b"private-second", body)
        self.assertNotIn(b"never-sent", body)
        self.assertFalse(messages[-1]["more_body"])
        self.assertEqual(sum(self.redis.used.values()), len(b"data: first\n\n"))

    async def test_sse_quota_store_failure_emits_safe_event_and_closes(self):
        messages, closed = [], []
        async def app(scope, receive, send):
            scope.setdefault("state", {})["limit_identity"] = "verified:alice"
            try:
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"text/event-stream")]})
                await send({"type": "http.response.body", "body": b"data: private\n\n", "more_body": True})
                await send({"type": "http.response.body", "body": b"data: never-sent\n\n", "more_body": False})
            finally:
                closed.append(True)
        scope = {"type": "http", "method": "GET", "path": "/stream", "headers": []}
        with patch("data_limits.get_redis_pool", side_effect=RuntimeError("isolated outage")), \
             self.assertLogs("data_limits", level="ERROR"):
            await DataLimitsMiddleware(app)(scope, AsyncMock(), AsyncMock(side_effect=lambda message: messages.append(message)))
        body = b"".join(message.get("body", b"") for message in messages)
        self.assertIn(b"event: throttled", body)
        self.assertIn(b"retry: 5000", body)
        self.assertNotIn(b"private", body)
        self.assertNotIn(b"never-sent", body)
        self.assertEqual(closed, [True])


@unittest.skipUnless(os.getenv("TEST_REDIS_URL"), "Set TEST_REDIS_URL for isolated Redis integration tests")
class RedisDataQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def test_atomic_debits_expiry_and_rejected_bytes_are_not_charged(self):
        url = os.environ["TEST_REDIS_URL"]
        if urlparse(url).hostname != "redis-test":
            self.fail("Data quota integration tests require the isolated redis-test hostname")
        redis = aioredis.from_url(url, decode_responses=True, socket_connect_timeout=20,
                                 socket_timeout=20, max_connections=8)
        self.addAsyncCleanup(redis.aclose)
        identity = "isolated-data-test:" + uuid.uuid4().hex
        key = data_limits.DATA_KEY_PREFIX + hashlib.sha256(identity.encode()).hexdigest()
        async def cleanup_key():
            await redis.delete(key)
        self.addAsyncCleanup(cleanup_key)
        config = SimpleNamespace(DATA_BYTES_PER_MINUTE=80, DATA_WINDOW_SECONDS=60)
        concurrent = asyncio.Semaphore(8)
        async def debit():
            try:
                async with concurrent:
                    await consume_data_bytes(identity, 8)
                return True
            except HTTPException as error:
                self.assertEqual(error.status_code, 429)
                return False
        with patch("data_limits.get_redis_pool", return_value=redis), patch("data_limits.settings", config):
            await redis.ping()
            results = await asyncio.gather(*(debit() for _ in range(50)))
            self.assertEqual(sum(results), 10)
            self.assertEqual(int(await redis.get(key)), 80)
            self.assertGreater(await redis.ttl(key), 0)
            self.assertLessEqual(await redis.ttl(key), 60)
            await redis.expire(key, 1)
            await asyncio.sleep(1.1)
            await consume_data_bytes(identity, 8)
            self.assertEqual(int(await redis.get(key)), 8)


if __name__ == "__main__":
    unittest.main()
