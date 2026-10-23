"""Correlation survives failures without logging request content or identities."""
import asyncio
from datetime import timedelta
import json
from pathlib import Path
import sys
import unittest
import uuid
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, HTTPException, Request
import httpx

from api_errors import install_api_error_handlers
from request_admission import RequestAdmissionMiddleware
from request_observability import RequestObservabilityMiddleware, request_id_context


FIRST = "357cd693-78c1-4362-b185-ef1d82bc7674"


def fixture():
    app = FastAPI()
    install_api_error_handlers(app)
    app.add_middleware(RequestAdmissionMiddleware)
    app.add_middleware(RequestObservabilityMiddleware)

    @app.post("/records/{record_id}")
    async def echo(record_id: str, request: Request):
        await asyncio.sleep(0)
        return {"requestId": request_id_context.get()}

    @app.get("/unexpected")
    async def unexpected():
        raise RuntimeError("private error")

    @app.get("/unavailable")
    async def unavailable():
        raise HTTPException(503, "Unavailable", headers={"Retry-After": "3"})

    return app


class RequestObservabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(
            app=fixture(), raise_app_exceptions=False), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)

    async def test_correlation_and_logs_exclude_body_query_credentials_and_record_id(self):
        with self.assertLogs("inout.requests", level="INFO") as logs:
            response = await self.client.post("/records/private-id?search=private-search",
                json={"note": "private-note"}, headers={"X-Request-ID": FIRST.upper(),
                    "Authorization": "Bearer private-token", "Cookie": "secret-cookie"})
        self.assertEqual(response.headers["X-Request-ID"], FIRST)
        self.assertEqual(response.json()["requestId"], FIRST)
        entry = json.loads(logs.records[0].getMessage())
        self.assertEqual(entry["route"], "/records/{record_id}")
        self.assertEqual(entry["status"], 200)
        self.assertEqual(entry["request_id"], FIRST)
        self.assertGreaterEqual(entry["duration_ms"], entry["headers_ms"])
        for secret in ("private-id", "private-search", "private-note", "private-token", "secret-cookie"):
            self.assertNotIn(secret, logs.records[0].getMessage())
        self.assertIsNone(request_id_context.get())

    async def test_invalid_and_duplicate_request_ids_are_replaced(self):
        for headers in ({"X-Request-ID": "x" * 1000}, [("X-Request-ID", FIRST), ("X-Request-ID", FIRST)]):
            with self.assertLogs("inout.requests", level="INFO"):
                response = await self.client.post("/records/id", headers=headers)
            value = response.headers["X-Request-ID"]
            self.assertEqual(str(uuid.UUID(value)), value)
            self.assertNotEqual(value, FIRST)

    async def test_concurrent_requests_and_http_errors_keep_separate_ids(self):
        other = str(uuid.uuid4())
        with self.assertLogs("inout.requests", level="INFO"):
            responses = await asyncio.gather(*[
                self.client.post("/records/id", headers={"X-Request-ID": value}) for value in (FIRST, other)])
            failure = await self.client.get("/unavailable", headers={"X-Request-ID": FIRST})
        self.assertEqual([response.json()["requestId"] for response in responses], [FIRST, other])
        self.assertEqual(failure.status_code, 503)
        self.assertEqual(failure.headers["Retry-After"], "3")
        self.assertEqual(failure.headers["X-Request-ID"], FIRST)

    async def test_unexpected_errors_keep_correlation_and_failed_completion(self):
        with self.assertLogs("inout.requests", level="INFO") as logs, self.assertLogs("api_errors", level="ERROR"):
            response = await self.client.get("/unexpected", headers={"X-Request-ID": FIRST})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["X-Request-ID"], FIRST)
        entry = json.loads(logs.records[0].getMessage())
        self.assertEqual(entry["outcome"], "failed")
        self.assertEqual(entry["status"], 500)
        self.assertIsNone(request_id_context.get())

    async def test_early_admission_failure_is_correlated(self):
        with patch("request_admission.settings.REQUEST_ADMISSION_CONCURRENCY", 0), self.assertLogs("inout.requests", level="INFO"):
            response = await self.client.get("/not-a-route?secret=hidden", headers={"X-Request-ID": FIRST})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["X-Request-ID"], FIRST)

    async def test_database_deadline_completion_matches_outer_503_response(self):
        from sqlalchemy.exc import TimeoutError as PoolTimeoutError
        app = fixture()

        @app.get("/database-timeout")
        async def database_timeout():
            raise PoolTimeoutError("private connection information")

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                     base_url="http://test") as client:
            with self.assertLogs("inout.requests", level="INFO") as logs, self.assertLogs("api_errors", level="WARNING"):
                response = await client.get("/database-timeout", headers={"X-Request-ID": FIRST})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["X-Request-ID"], FIRST)
        self.assertEqual(json.loads(logs.records[0].getMessage())["status"], 503)
        self.assertNotIn("private", logs.records[0].getMessage())

    async def test_cancelled_stream_resets_context_and_logs_once(self):
        async def stream(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            raise asyncio.CancelledError
        scope = {"type": "http", "method": "GET", "headers": [(b"x-request-id", FIRST.encode())]}
        with self.assertLogs("inout.requests", level="INFO") as logs:
            with self.assertRaises(asyncio.CancelledError):
                await RequestObservabilityMiddleware(stream)(scope, AsyncMock(), AsyncMock())
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(json.loads(logs.records[0].getMessage())["outcome"], "cancelled")
        self.assertIsNone(request_id_context.get())


class ReadinessDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_readiness_bounds_temporal_rpc(self):
        import main
        db, redis, temporal = AsyncMock(), AsyncMock(), AsyncMock()
        with patch.object(main, "get_redis_pool", return_value=redis), \
             patch.object(main, "get_temporal_client", new=AsyncMock(return_value=temporal)):
            self.assertEqual((await main.health_ready(db))["status"], "ready")
        self.assertEqual(temporal.workflow_service.get_cluster_info.call_args.kwargs["timeout"], timedelta(seconds=2))

    async def test_stalled_dependency_returns_unavailable_before_probe_deadline(self):
        import main
        db = AsyncMock()
        async def stalled(*args):
            await asyncio.Event().wait()
        db.execute.side_effect = stalled
        with patch.object(main, "_READINESS_TIMEOUT_SECONDS", .01), self.assertLogs("main", level="ERROR"):
            with self.assertRaises(HTTPException) as error:
                await main.health_ready(db)
        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
