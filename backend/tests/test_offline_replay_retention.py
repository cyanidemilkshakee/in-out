"""Expired queue evidence survives cleanup without becoming a fresh movement."""
from datetime import datetime, timedelta, timezone
import unittest
import uuid
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import delete, func, select

import test_database as fixture
from config import settings
from models import EventOutbox, Movement, Person, PresenceState, ScanRequest
from schemas import BrowserScanPayload
from terminal_scans import record_scan, validate_queued_scan_age


NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)


class OfflineReplayAgeTests(unittest.TestCase):
    def payload(self, **values):
        return BrowserScanPayload(barcode="p1", checkpointId="cp-main", **values)

    def test_exact_retention_boundary_and_indefinite_policy(self):
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 30):
            validate_queued_scan_age(self.payload(queueCapturedAt=NOW - timedelta(days=30) + timedelta(microseconds=1)), now=NOW)
            for stamp in (NOW - timedelta(days=30), NOW - timedelta(days=31)):
                with self.assertRaises(HTTPException) as error:
                    validate_queued_scan_age(self.payload(queueCapturedAt=stamp), now=NOW)
                self.assertEqual(error.exception.detail["code"], "offline_replay_expired")
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 0):
            validate_queued_scan_age(self.payload(queueCapturedAt=NOW - timedelta(days=50000)), now=NOW)

    def test_future_naive_and_legacy_declared_offline_timestamps(self):
        for stamp in (NOW + timedelta(microseconds=1), NOW.replace(tzinfo=None)):
            with self.assertRaises(HTTPException) as error:
                validate_queued_scan_age(self.payload(queueCapturedAt=stamp), now=NOW)
            self.assertEqual(error.exception.detail["code"], "offline_replay_time_unverifiable")
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 30):
            with self.assertRaises(HTTPException):
                validate_queued_scan_age(self.payload(capturedOfflineAt=NOW - timedelta(days=31)), now=NOW)
        # A fresh scan has no queue timestamp; the original scan contract remains.
        validate_queued_scan_age(self.payload(), now=NOW)

    def test_server_anchored_transport_evidence_does_not_use_browser_wall_clock(self):
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 30):
            validate_queued_scan_age(self.payload(queueCapturedAt=NOW,
                capturedOfflineAt=NOW - timedelta(days=500)), now=NOW)


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class OfflineReplayRetentionTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def test_expired_lost_response_after_receipt_cleanup_cannot_toggle_presence(self):
        key = uuid.uuid4()
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
        async with self.sessions() as db:
            first = await record_scan(db, key, payload, "browser:operator")
            self.assertTrue(first["allowed"])
            receipt = await db.get(ScanRequest, key)
            receipt.created_at = datetime.now(timezone.utc) - timedelta(days=31)
            await db.commit()
            await db.execute(delete(ScanRequest).where(ScanRequest.idempotency_key == key))
            await db.commit()
        queued = payload.model_copy(update={"queue_captured_at": datetime.now(timezone.utc) - timedelta(days=31)})
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 30):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as error:
                    await record_scan(db, key, queued, "browser:operator")
                self.assertEqual(error.exception.detail["code"], "offline_replay_expired")
                await db.rollback()
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
                self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")
                self.assertIsNone(await db.get(ScanRequest, key))
                self.assertEqual(await db.scalar(select(func.count()).select_from(EventOutbox)), 0)

    async def test_retry_sidecar_preserves_fingerprint_and_existing_receipt_replay(self):
        key = uuid.uuid4()
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
        async with self.sessions() as db:
            first = await record_scan(db, key, payload, "browser:operator")
            await db.commit()
        for age in (1, 31):
            async with self.sessions() as db:
                result = await record_scan(db, key, payload.model_copy(update={
                    "queue_captured_at": datetime.now(timezone.utc) - timedelta(days=age)}), "browser:operator")
                self.assertTrue(result["replayed"])
                self.assertFalse(result["authorizeMovement"])
                self.assertEqual(result["decision"]["event"]["id"], first["decision"]["event"]["id"])
                await db.commit()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertTrue((await db.get(Person, "p1")).data["inside"])

    async def test_new_offline_payload_outside_window_cannot_create_any_scan_evidence(self):
        key = uuid.uuid4()
        payload = BrowserScanPayload(barcode="unregistered", checkpointId="cp-main",
            capturedOfflineAt=datetime.now(timezone.utc) - timedelta(days=31))
        with patch.object(settings, "IDEMPOTENCY_RETENTION_DAYS", 30):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException):
                    await record_scan(db, key, payload, "browser:operator")
                await db.rollback()
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)
                self.assertIsNone(await db.get(ScanRequest, key))


if __name__ == "__main__":
    unittest.main()
