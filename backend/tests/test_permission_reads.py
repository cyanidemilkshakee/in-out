"""Bounded permission views retain scope, exact counts and legacy defaults."""
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.dialects import postgresql

import test_database as fixture
from auth import verify_admin_request
from models import AccessPermission, CriticalEntryRestriction, PermissionRequestModel, Person, Subject
from permission_reads import permission_directory_page, pending_permission_page


class PermissionReadQueryTests(unittest.IsolatedAsyncioTestCase):
    async def test_directory_filters_and_pagination_are_applied_before_loading_metadata(self):
        subject = SimpleNamespace(id="p1", kind="employee", barcode="EMP-1")
        rows = MagicMock()
        rows.all.return_value = [(subject, {"name": "Alice", "status": "active", "allowedZones": ["a"]}, None, None, "policy")]
        checkpoints = MagicMock()
        checkpoints.all.return_value = []
        db = SimpleNamespace(scalar=AsyncMock(return_value=17), execute=AsyncMock(return_value=rows),
            scalars=AsyncMock(return_value=checkpoints))
        with patch("permission_reads.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            result = await permission_directory_page(db, ["a"], limit=5, offset=10, search="%_", subject_group="people", state="restricted", subject_id="p1")
        self.assertEqual((result["total"], result["limit"], result["offset"]), (17, 5, 10))
        self.assertEqual((result["items"][0]["subjectName"], result["people"][0]["barcode"]), ("Alice", "EMP-1"))
        query = db.execute.await_args.args[0]
        compiled = query.compile(dialect=postgresql.dialect())
        self.assertEqual((query._limit_clause.value, query._offset_clause.value), (5, 10))
        self.assertIn("critical_entry_restrictions.active IS true", str(compiled))
        self.assertIn("p1", compiled.params.values())
        self.assertIn("%\\%\\_%", compiled.params.values())
        self.assertIn("organization_zones", str(compiled))
        self.assertIn("a", str(compiled.params))

    async def test_pending_summary_is_independent_of_selected_queue_and_rows_remain_bounded(self):
        summary = MagicMock()
        summary.mappings.return_value.one.return_value = {"manual": 4, "other": 2}
        rows = MagicMock()
        rows.all.return_value = []
        db = SimpleNamespace(execute=AsyncMock(return_value=summary), scalars=AsyncMock(return_value=rows))
        result = await pending_permission_page(db, ["a"], limit=2, offset=2, type_group="manual", request_id="request-1")
        self.assertEqual((result["summary"], result["total"]), ({"manual": 4, "other": 2}, 4))
        query = db.scalars.await_args_list[0].args[0]
        compiled = query.compile(dialect=postgresql.dialect())
        self.assertEqual((query._limit_clause.value, query._offset_clause.value), (2, 2))
        self.assertIn("request-1", compiled.params.values())
        self.assertIn("requestedZones", compiled.params.values())


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class PermissionReadDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "review-admin", "realm_access": {"roles": ["zone-admin"]}}

    async def test_directory_keeps_scope_policy_fallback_restrictions_and_legacy_snapshot(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add_all([Subject(id="outside", kind="employee", barcode="OUTSIDE", person=Person(data={"name": "Outside", "allowedZones": ["outside"]})),
                Subject(id="pending-visitor", kind="visitor", barcode="PENDING", person=Person(data={"name": "Pending", "status": "pending_approval", "allowedZones": ["a"]})),
                AccessPermission(id="p1-access", subject_id="p1", data={"id": "p1-access", "subjectId": "p1", "subjectName": "Alice", "state": "active", "zones": ["a"]}),
                CriticalEntryRestriction(subject_id="p1", active=True, triggered_at=now, trigger_alert_id="test-hold")])
            await db.commit()
        legacy = await self.client.get("/v1/permissions")
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertIn("subjects", legacy.json())
        page = await self.client.get("/v1/permissions", params={"view": "directory", "subjectGroup": "people", "state": "restricted", "limit": 1})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual((page.json()["total"], page.json()["items"][0]["subjectId"]), (1, "p1"))
        self.assertTrue(page.json()["items"][0]["entryRestriction"]["active"])
        for subject_id in ("outside", "pending-visitor"):
            hidden = await self.client.get("/v1/permissions", params={"view": "directory", "subjectId": subject_id})
            self.assertEqual(hidden.json()["items"], [])

    async def test_pending_pages_keep_all_types_counts_and_exact_deep_link(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            for index, kind in enumerate(("manual_override", "visitor", "hardware_custody", "zone_access")):
                request_id = f"pending-{index}"
                db.add(PermissionRequestModel(id=request_id, subject_id="p1", created_at=now, data={
                    "id": request_id, "type": kind, "status": "pending", "subjectId": "p1", "requestedZones": ["a"]}))
            db.add(PermissionRequestModel(id="decided", subject_id="p1", created_at=now,
                data={"id": "decided", "type": "visitor", "status": "approved"}))
            await db.commit()
        first = await self.client.get("/v1/permissions", params={"view": "pending", "typeGroup": "other", "limit": 1})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual((first.json()["total"], first.json()["summary"], len(first.json()["items"])), (3, {"manual": 1, "other": 3}, 1))
        self.assertEqual([person["id"] for person in first.json()["people"]], ["p1"])
        linked = await self.client.get("/v1/permissions", params={"view": "pending", "requestId": "pending-3"})
        self.assertEqual([item["id"] for item in linked.json()["items"]], ["pending-3"])
        decided = await self.client.get("/v1/permissions", params={"view": "pending", "requestId": "decided"})
        self.assertEqual(decided.json()["total"], 0)
