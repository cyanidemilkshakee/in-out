"""PostgreSQL scan regressions for complete, bounded manual-grant lookup."""
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select

import test_database as fixture
import test_manual_access_snapshots as manual_snapshots
from models import Movement, PermissionRequestModel, PresenceState, ScanRequest
from terminal_scans import record_scan


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class ManualReviewPagingTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown
    approve = manual_snapshots.ManualAccessSnapshotTests.approve

    async def add_expired_grants(self, original_id, count):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            original = await db.get(PermissionRequestModel, original_id)
            original.created_at = now - timedelta(minutes=20)
            original.data = {**original.data,
                "validFrom": original.created_at.isoformat(),
                "validTo": (original.created_at + timedelta(hours=4)).isoformat()}
            for index in range(count):
                identifier = f"expired-{index:03}"
                # Equal timestamps exercise the id tie-breaker in real SQL.
                db.add(PermissionRequestModel(id=identifier, subject_id=original.subject_id,
                    created_at=now - timedelta(minutes=19), data={**original.data, "id": identifier,
                        "validFrom": (now - timedelta(minutes=19)).isoformat(),
                        "validTo": "legacy-malformed-date" if index == 0 else
                            (now - timedelta(minutes=4)).isoformat()}))
            await db.commit()

    async def test_scan_consumes_original_four_hour_grant_behind_fifty_expired_newer_grants(self):
        payload, request_id, _ = await self.approve()
        await self.add_expired_grants(request_id, 50)
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(result["allowed"], result)
            self.assertEqual(result["manualApprovalRequest"]["id"], request_id)
            await db.commit()
            self.assertIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)
            expired = list(await db.scalars(select(PermissionRequestModel).where(
                PermissionRequestModel.id.like("expired-%"))))
            self.assertTrue(all("consumedAt" not in request.data for request in expired))
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 2)

    async def test_candidate_capacity_failure_rolls_back_without_scan_receipt_or_admission(self):
        payload, request_id, _ = await self.approve()
        await self.add_expired_grants(request_id, 2)
        key = uuid.uuid4()
        async with self.sessions() as db:
            with patch("terminal_scans._MANUAL_REVIEW_PAGE_SIZE", 2), \
                 patch("terminal_scans._MAX_MANUAL_REVIEW_CANDIDATES", 2):
                with self.assertRaises(HTTPException) as raised:
                    await record_scan(db, key, payload, "browser:operator")
            self.assertEqual(raised.exception.status_code, 503)
            self.assertEqual(raised.exception.detail["code"], "manual_review_capacity_exceeded")
            await db.rollback()
            self.assertIsNone(await db.get(ScanRequest, key))
            self.assertNotIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)


if __name__ == "__main__":
    unittest.main()
