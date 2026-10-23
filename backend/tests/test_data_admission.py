"""Response buffering retains HTTP admission; SSE uses separate stream leases."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from starlette.responses import JSONResponse
from config import settings
from data_limits import DataLimitsMiddleware
from request_admission import RequestAdmissionMiddleware


def scope(path="/protected"):
    return {"type": "http", "method": "GET", "path": path, "headers": [], "state": {}}


class DataAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_json_debit_keeps_admission_and_sends_no_partial_headers(self):
        debit_entered, release_debit = asyncio.Event(), asyncio.Event()
        entered, first_messages, second_messages = [], [], []

        async def debit(_identity, _amount):
            debit_entered.set()
            await release_debit.wait()

        async def protected(request_scope, receive, send):
            entered.append(True)
            request_scope["state"]["limit_identity"] = "verified:alice"
            await JSONResponse({"complete": [1, 2, 3]})(request_scope, receive, send)

        admission = RequestAdmissionMiddleware(protected)
        guarded = DataLimitsMiddleware(admission)
        with patch.object(settings, "REQUEST_ADMISSION_CONCURRENCY", 1), \
             patch("data_limits.consume_data_bytes", side_effect=debit) as quota:
            first = asyncio.create_task(guarded(scope(), AsyncMock(),
                AsyncMock(side_effect=lambda message: first_messages.append(message))))
            try:
                await asyncio.wait_for(debit_entered.wait(), 1)
                self.assertEqual(admission.active, 1)
                self.assertEqual(first_messages, [])
                await guarded(scope(), AsyncMock(),
                    AsyncMock(side_effect=lambda message: second_messages.append(message)))
                self.assertEqual(len(entered), 1)
                self.assertEqual(second_messages[0]["status"], 503)
                self.assertEqual(dict(second_messages[0]["headers"])[b"retry-after"], b"1")
                self.assertEqual(quota.await_count, 1)
            finally:
                release_debit.set()
                await asyncio.wait_for(first, 1)
        self.assertEqual(first_messages[0]["status"], 200)
        self.assertFalse(first_messages[-1]["more_body"])
        self.assertEqual(admission.active, 0)

    async def test_open_sse_releases_http_admission_while_json_can_still_finish(self):
        stream_entered, finish_stream = asyncio.Event(), asyncio.Event()
        stream_messages, data_messages = [], []

        async def protected(request_scope, receive, send):
            request_scope["state"]["limit_identity"] = "verified:alice"
            if request_scope["path"] == "/stream":
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"text/event-stream; charset=utf-8")]})
                await send({"type": "http.response.body", "body": b": heartbeat\n\n", "more_body": True})
                stream_entered.set()
                await finish_stream.wait()
                await send({"type": "http.response.body", "body": b"", "more_body": False})
            else:
                await JSONResponse({"complete": True})(request_scope, receive, send)

        admission = RequestAdmissionMiddleware(protected)
        guarded = DataLimitsMiddleware(admission)
        with patch.object(settings, "REQUEST_ADMISSION_CONCURRENCY", 1), \
             patch("data_limits.consume_data_bytes", new=AsyncMock()):
            stream = asyncio.create_task(guarded(scope("/stream"), AsyncMock(),
                AsyncMock(side_effect=lambda message: stream_messages.append(message))))
            try:
                await asyncio.wait_for(stream_entered.wait(), 1)
                self.assertEqual(admission.active, 0)
                self.assertFalse(stream.done())
                await guarded(scope(), AsyncMock(),
                    AsyncMock(side_effect=lambda message: data_messages.append(message)))
                self.assertEqual(data_messages[0]["status"], 200)
                self.assertEqual(admission.active, 0)
            finally:
                finish_stream.set()
                await asyncio.wait_for(stream, 1)
        self.assertEqual(stream_messages[0]["status"], 200)
        self.assertFalse(stream_messages[-1]["more_body"])
        self.assertEqual(admission.active, 0)


if __name__ == "__main__":
    unittest.main()
