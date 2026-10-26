"""Exports keep canonical filters/history, admission bounds and cancellation."""
import asyncio
from datetime import datetime, timedelta, timezone
import os
from unittest.mock import AsyncMock, patch
import unittest
import uuid

import test_database as fixture
from auth import verify_admin_request
from config import settings
from models import Movement, MovementNote
from routers import exports
from schemas import BrowserScanPayload
from terminal_scans import record_scan


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Dedicated PostgreSQL required")
class ExportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.DatabaseTests.asyncSetUp(self)
        self.app.include_router(exports.router)

    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "export-admin", "realm_access": {"roles": ["admin"]}}

    async def test_authentication_and_public_row_limits_are_preserved(self):
        self.assertEqual((await self.client.get("/v1/exports?source=movements")).status_code, 401)
        self.authorize()
        for query in ("source=invalid", "source=registry", "source=registry&kind=employee&days=366",
                      "source=movements&limit=1000000", "source=movements&scanType=invalid",
                      "source=movements&startAt=2026-10-10&endAt=2026-10-09"):
            response = await self.client.get("/v1/exports?" + query)
            self.assertEqual(response.status_code, 422, (query, response.text))

    async def test_single_read_returns_more_than_one_public_page_and_exact_filters(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add_all([Movement(id=f"export-{index:04}", subject_id="p1", checkpoint_id="cp-main",
                occurred_at=now - timedelta(minutes=index), result="approved", direction="entry",
                scan_type="auto", subject_type="employee", sync_state="synced", data={"subjectName": "Alice"})
                for index in range(220)])
            await db.commit()
        response = await self.client.get("/v1/exports", params={"source": "movements", "subject_id": "p1"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["total"], len(response.json()["items"])), (220, 220))
        response = await self.client.get("/v1/exports", params={"source": "movements", "result": "denied"})
        self.assertEqual(response.json()["items"], [])
        normal = await self.client.get("/v1/movements?limit=10000")
        self.assertEqual(normal.status_code, 422)

    async def test_virtual_hardware_history_and_parent_notes_have_export_parity(self):
        self.authorize()
        async with self.sessions() as db:
            scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main",
                selectedHardwareIds=["h1"]), "test:export")
            source = scan["decision"]["event"]["id"]
            db.add(MovementNote(event_id=source, note="Verified for export", created_at=datetime.now(timezone.utc)))
            await db.commit()
        query = {"source": "movements", "subjectGroup": "hardware", "subject_id": "h1"}
        exported = await self.client.get("/v1/exports", params=query)
        normal = await self.client.get("/v1/movements", params={key: value for key, value in query.items() if key != "source"})
        self.assertEqual(exported.status_code, 200, exported.text)
        self.assertEqual(exported.json()["items"], normal.json()["items"])
        self.assertEqual(exported.json()["movementNotes"], normal.json()["movementNotes"])
        self.assertEqual(exported.json()["items"][0]["data"]["sourceEventId"], source)

    async def test_registry_export_is_complete_and_row_and_byte_caps_reject_before_success(self):
        self.authorize()
        response = await self.client.get("/v1/exports?source=registry&kind=employee&days=7")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["total"], response.json()["people"][0]["id"]), (1, "p1"))
        with patch.object(settings, "MAX_DATA_RESPONSE_BYTES", 1):
            response = await self.client.get("/v1/exports?source=registry&kind=employee")
            self.assertEqual(response.status_code, 413, response.text)
        with patch.object(settings, "DATA_SNAPSHOT_MAX_ROWS", 0):
            response = await self.client.get("/v1/exports?source=registry&kind=employee")
            self.assertEqual(response.status_code, 422, response.text)


class ExportCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_cancels_database_read(self):
        cancelled = asyncio.Event()

        async def stalled(*_args):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        request = type("Request", (), {"is_disconnected": AsyncMock(side_effect=[False, True])})()
        with patch.object(exports, "build_export", stalled):
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as error:
                await exports.export_records(request, exports.ExportQuery(source="movements"), object(), {})
        self.assertEqual(error.exception.status_code, 499)
        self.assertTrue(cancelled.is_set())
