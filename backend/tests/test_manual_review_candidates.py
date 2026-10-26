"""Manual grants are found behind expired rows or fail explicitly at capacity."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

import terminal_scans


NOW = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)


class ScalarRows(list):
    def all(self):
        return self


class ManualReviewCandidatesTests(unittest.IsolatedAsyncioTestCase):
    def request(self, identifier, *, valid=False, created_at=None):
        return SimpleNamespace(id=identifier, subject_id="p1",
            created_at=created_at or NOW - timedelta(minutes=19), data={
                "type": "manual_override", "status": "approved", "barcode": "p1",
                "checkpointId": "cp-main", "direction": "entry", "eventId": "source",
                "validFrom": (NOW - timedelta(minutes=20)).isoformat(),
                "validTo": (NOW + timedelta(minutes=220) if valid else NOW - timedelta(minutes=4)).isoformat(),
                "hardwareCustody": {}, "accessSnapshots": {"p1": {"state": "restricted"}},
            })

    def db(self, pages, *, more=None):
        source = SimpleNamespace(id="source", subject_id="p1", result="denied", direction="entry",
            checkpoint_id="cp-main", occurred_at=NOW - timedelta(minutes=21),
            data={"barcode": "p1", "hardwareIds": []})
        return SimpleNamespace(scalars=AsyncMock(side_effect=[ScalarRows(page) for page in pages]),
            scalar=AsyncMock(return_value=more), get=AsyncMock(return_value=source))

    async def approved(self, db):
        return await terminal_scans._approved_manual_review(db, "p1", "p1", "employee", "cp-main",
            "entry", [], NOW, {"p1": SimpleNamespace(last_scan_timestamp=None)}, {},
            {"p1": {"state": "restricted"}})

    async def test_valid_four_hour_grant_is_found_behind_fifty_expired_newer_grants(self):
        expired = [self.request(f"new-{index:03}") for index in range(50, 0, -1)]
        valid = self.request("original", valid=True, created_at=NOW - timedelta(minutes=20))
        db = self.db([expired, [valid]])
        self.assertIs(await self.approved(db), valid)
        self.assertEqual(db.scalars.await_count, 2)
        db.scalar.assert_not_awaited()
        db.get.assert_awaited_once()

    async def test_ordinary_valid_grant_needs_one_query_and_keeps_python_validation(self):
        invalid = self.request("malformed")
        invalid.data["validTo"] = "legacy-invalid-timestamp"
        wrong_context = self.request("wrong-context", valid=True)
        wrong_context.data["hardwareCustody"] = {"h1": {"ownerId": "someone-else"}}
        valid = self.request("valid", valid=True)
        db = self.db([[invalid, wrong_context, valid]])
        self.assertIs(await self.approved(db), valid)
        db.scalars.assert_awaited_once()
        db.scalar.assert_not_awaited()

    async def test_tied_timestamps_advance_by_id_and_retain_row_locks(self):
        first = [self.request("c"), self.request("b")]
        valid = self.request("a", valid=True)
        db = self.db([first, [valid]])
        with patch.object(terminal_scans, "_MANUAL_REVIEW_PAGE_SIZE", 2):
            self.assertIs(await self.approved(db), valid)
        statement = db.scalars.await_args_list[1].args[0]
        compiled = statement.compile(dialect=postgresql.dialect())
        self.assertIn("(permission_requests.created_at, permission_requests.id) <", str(compiled))
        self.assertIn("permission_requests.created_at DESC, permission_requests.id DESC", str(compiled))
        self.assertIn(NOW - timedelta(minutes=19), compiled.params.values())
        self.assertIn("b", compiled.params.values())
        self.assertIn("FOR UPDATE", str(compiled))
        self.assertEqual(statement._limit_clause.value, 2)

    async def test_capacity_overflow_fails_explicitly_after_finite_bounded_pages(self):
        db = self.db([[self.request("d"), self.request("c")],
                      [self.request("b"), self.request("a")]], more="older")
        with patch.object(terminal_scans, "_MANUAL_REVIEW_PAGE_SIZE", 2), \
             patch.object(terminal_scans, "_MAX_MANUAL_REVIEW_CANDIDATES", 4):
            with self.assertRaises(HTTPException) as raised:
                await self.approved(db)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail["code"], "manual_review_capacity_exceeded")
        self.assertEqual(db.scalars.await_count, 2)
        db.scalar.assert_awaited_once()
        statement = db.scalar.await_args.args[0]
        self.assertEqual(statement._limit_clause.value, 1)
        self.assertEqual(len(statement.selected_columns), 1)
        db.get.assert_not_awaited()

    async def test_exact_capacity_can_prove_no_eligible_grant_without_loading_more_json(self):
        db = self.db([[self.request("b"), self.request("a")]], more=None)
        with patch.object(terminal_scans, "_MANUAL_REVIEW_PAGE_SIZE", 2), \
             patch.object(terminal_scans, "_MAX_MANUAL_REVIEW_CANDIDATES", 2):
            self.assertIsNone(await self.approved(db))
        db.scalars.assert_awaited_once()
        db.scalar.assert_awaited_once()

    async def test_short_page_proves_absence_without_overflow_probe(self):
        db = self.db([[self.request("expired")]])
        self.assertIsNone(await self.approved(db))
        db.scalars.assert_awaited_once()
        db.scalar.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
