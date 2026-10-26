"""Focused Registry reads retain complete totals without eager history directories."""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_database as fixture
from auth import verify_admin_request
from config import settings
from models import AccessPermission, Alert, AuditEvent, HardwareAsset, Movement, Person, PresenceState, Subject
from movement_analytics import FACILITY_ZONE
from registry_reads import trend_summary


class RegistryTrendTests(unittest.TestCase):
    def test_complete_current_and_previous_buckets_preserve_counts_and_average(self):
        end = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)
        start = end - timedelta(days=1)
        points = [(start + timedelta(minutes=index), 1) for index in range(1440)]
        points += [(start - timedelta(hours=1), 500)]
        summary = trend_summary(points, start, end, 1, False)
        self.assertEqual(sum(summary["values"]), 1440)
        self.assertEqual(summary["value"], 1440)
        self.assertEqual(summary["percentage"], 188)
        self.assertTrue(summary["isUp"])
        hours = trend_summary([(start, 4), (start, 8), (start - timedelta(hours=1), 3)], start, end, 1, True)
        self.assertEqual((hours["value"], hours["percentage"]), (6, 100))


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class RegistryReadDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "registry-read-admin"}

    async def seed_employees(self, count):
        async with self.sessions() as db:
            db.add_all([Subject(id=f"employee-{index:03}", kind="employee", barcode=f"EMP-{index:03}",
                person=Person(data={"name": f"Employee {index:03}", "status": "active", "allowedZones": ["public"]}))
                for index in range(count)])
            await db.flush()
            db.add(PresenceState(subject_id="employee-000", state="inside"))
            await db.commit()

    async def test_registry_first_page_and_complete_pagination_have_exact_global_metrics(self):
        self.authorize()
        await self.seed_employees(60)
        seen = set()
        for offset in (0, 25, 50):
            response = await self.client.get("/v1/registry/bundle", params={"kind": "employee", "limit": 25,
                "offset": offset, "days": 1, "sortKey": "name", "includeOverview": offset == 0})
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()
            self.assertEqual(page["total"], 61)
            self.assertLessEqual(len(page["people"]), 25)
            self.assertEqual(page["hardwareAssets"], [])
            self.assertTrue(isinstance(page["eventRevision"], int))
            self.assertFalse({"alerts", "permissions", "auditEvents", "permissionRequests"}.intersection(page))
            ids = {person["id"] for person in page["people"]}
            self.assertFalse(seen.intersection(ids))
            seen.update(ids)
            if offset == 0:
                self.assertEqual((page["summary"]["total"], page["summary"]["inside"]), (61, 1))
            else:
                self.assertNotIn("trend", page)
                self.assertNotIn("summary", page)
        self.assertEqual(len(seen), 61)

    async def test_search_is_literal_kind_specific_and_ordering_crosses_page_boundaries(self):
        self.authorize()
        await self.seed_employees(30)
        async with self.sessions() as db:
            db.add(Subject(id="literal", kind="employee", barcode="EMP-%_literal", person=Person(data={
                "name": "Literal %_ name", "status": "active", "allowedZones": ["public"]})))
            db.add(Subject(id="visitor-literal", kind="visitor", barcode="VIS-%_literal", person=Person(data={
                "name": "Visitor %_ name", "status": "pending_approval", "host": "Alice", "allowedZones": ["public"]})))
            await db.commit()
        response = await self.client.get("/v1/registry/subjects", params={"kind": "employee", "search": "%_", "limit": 25})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in response.json()["items"]], ["literal"])
        people = await self.client.get("/v1/registry/subjects", params={"kind": "people", "search": "%_", "limit": 25})
        self.assertEqual(people.json()["total"], 2)
        first = (await self.client.get("/v1/registry/bundle", params={"kind": "employee", "limit": 2,
            "offset": 0, "sortKey": "name", "sortDirection": "desc", "includeOverview": False})).json()
        second = (await self.client.get("/v1/registry/bundle", params={"kind": "employee", "limit": 2,
            "offset": 2, "sortKey": "name", "sortDirection": "desc", "includeOverview": False})).json()
        names = [item["name"] for page in (first, second) for item in page["people"]]
        self.assertEqual(names, sorted(names, key=str.lower, reverse=True))

    async def test_profile_is_subject_scoped_and_does_not_load_lifetime_history(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add_all([AccessPermission(id="p1-access", subject_id="p1", data={"id": "p1-access", "subjectId": "p1", "zones": ["public"]}),
                AccessPermission(id="h1-access", subject_id="h1", data={"id": "h1-access", "subjectId": "h1", "zones": ["secure"]}),
                Alert(id="unrelated-alert", data={"title": "Unrelated", "subjectId": "h1"}, created_at=now),
                AuditEvent(id="unrelated-audit", data={"description": "Unrelated"}, created_at=now)])
            await db.commit()
        response = await self.client.get("/v1/registry/bundle", params={"subjectId": "p1"})
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()
        self.assertEqual(profile["person"]["id"], "p1")
        self.assertEqual([item["id"] for item in profile["permissions"]], ["p1-access"])
        self.assertFalse({"movements", "alerts", "auditEvents", "people", "hardwareAsset"}.intersection(profile))
        self.assertEqual((await self.client.get("/v1/registry/bundle", params={"subjectId": "missing"})).status_code, 404)

    async def test_employee_hours_and_trend_are_complete_and_not_a_movement_sample(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        day = now.astimezone(FACILITY_ZONE).date() - timedelta(days=1)
        start = datetime.combine(day, datetime.min.time(), FACILITY_ZONE) + timedelta(hours=9)
        async with self.sessions() as db:
            db.add_all([Movement(id=f"work-{direction}", subject_id="p1", checkpoint_id="cp-main", subject_type="employee",
                occurred_at=timestamp, direction=direction, result="approved", scan_type="auto", sync_state="synced", data={})
                for direction, timestamp in (("entry", start), ("exit", start + timedelta(hours=8)))])
            await db.commit()
        response = await self.client.get("/v1/registry/bundle", params={"kind": "employee", "days": 7, "limit": 25})
        self.assertEqual(response.status_code, 200, response.text)
        page = response.json()
        self.assertAlmostEqual(page["averages"]["p1"], 8 / 7, places=2)
        self.assertEqual(page["trend"]["value"], 8)
        self.assertEqual(len(page["movements"]), 1, "Bootstrap includes latest scan only, not history")
        self.assertEqual(page["activityDays"]["p1"][0]["workedHours"], 8)

    async def test_activity_capacity_rejects_incomplete_answers_and_public_limits_validate(self):
        self.authorize()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add_all([Movement(id=f"overload-{index}", subject_id="p1", checkpoint_id="cp-main", subject_type="employee",
                occurred_at=now - timedelta(seconds=10 - index), direction="entry" if index % 2 == 0 else "exit",
                result="approved", scan_type="auto", sync_state="synced", data={}) for index in range(3)])
            await db.commit()
        with patch.object(settings, "DATA_ANALYTICS_MAX_ROWS", 2):
            response = await self.client.get("/v1/registry/bundle", params={"kind": "employee", "includeOverview": False})
        self.assertEqual(response.status_code, 422, response.text)
        for params in ({"kind": "employee", "limit": 201}, {"kind": "employee", "offset": -1},
                       {"kind": "employee", "days": 366}, {"kind": "employee", "sortKey": "password"}):
            self.assertEqual((await self.client.get("/v1/registry/bundle", params=params)).status_code, 422)
