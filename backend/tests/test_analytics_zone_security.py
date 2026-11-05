"""Analytics obey the same branch boundaries as Registry and movement history."""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI

from auth import verify_admin_request
from database import get_read_db
from movement_analytics import router


class AnalyticsAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = SimpleNamespace(
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])),
            scalar=AsyncMock(return_value=None), execute=AsyncMock(),
        )
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_read_db] = lambda: self.db
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "unassigned-admin", "realm_access": {"roles": ["zone-admin"]},
        }
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")
        self.addAsyncCleanup(self.client.aclose)

    async def test_all_analytics_endpoints_reject_admin_without_active_zone_before_reading_data(self):
        for endpoint in ("/dashboard-analytics", "/employee-activity?subjectId=foreign", "/employee-activity-summary"):
            with self.subTest(endpoint=endpoint):
                result = await self.client.get(endpoint)
                self.assertEqual(result.status_code, 403, result.text)
        self.db.scalar.assert_not_awaited()
        self.db.execute.assert_not_awaited()

    async def test_routes_require_authentication_even_when_mounted_without_parent_dependencies(self):
        del self.app.dependency_overrides[verify_admin_request]
        for endpoint in ("/dashboard-analytics", "/employee-activity?subjectId=foreign", "/employee-activity-summary"):
            with self.subTest(endpoint=endpoint):
                result = await self.client.get(endpoint)
                self.assertEqual(result.status_code, 401, result.text)
        self.db.scalars.assert_not_awaited()
        self.db.scalar.assert_not_awaited()
        self.db.execute.assert_not_awaited()

    async def test_foreign_employee_is_not_an_attendance_enumeration_oracle(self):
        self.db.scalars.return_value = SimpleNamespace(all=lambda: ["a"])
        result = await self.client.get("/employee-activity", params={"subjectId": "foreign"})
        self.assertEqual(result.status_code, 404, result.text)
        self.db.execute.assert_not_awaited()
        query = self.db.scalar.await_args.args[0]
        compiled = query.compile()
        self.assertIn("access_permissions", str(query))
        self.assertIn(["a"], list(compiled.params.values()))


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Requires isolated PostgreSQL ending in _test")
class AnalyticsZoneDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import test_database as fixture
        from models import Alert, AlertReview, Movement, Person, PresenceState, Subject, ZoneAdminAssignment

        await fixture.DatabaseTests.asyncSetUp(self)
        yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
        self.start = datetime.combine(yesterday, datetime.min.time(), timezone.utc) + timedelta(hours=3, minutes=30)
        self.end = self.start + timedelta(hours=8)
        async with self.sessions() as db:
            db.add(ZoneAdminAssignment(admin_subject="only-a", zone_id="a", assigned_by="fixture"))
            db.add_all([
                Subject(id="foreign", kind="employee", barcode="foreign", person=Person(data={
                    "name": "Foreign employee", "allowedZones": ["b"], "status": "active"})),
                Subject(id="local", kind="employee", barcode="local", person=Person(data={
                    "name": "Local employee", "allowedZones": ["a"], "status": "active"})),
            ])
            await db.flush()
            db.add_all([PresenceState(subject_id="p1", state="inside"),
                        PresenceState(subject_id="foreign", state="inside")])
            for subject_id, checkpoint, entry, exit_ in (
                ("p1", "cp-main", 0, 1), ("p1", "b-1", 2, 6), ("foreign", "b-1", 0, 5),
            ):
                for direction, hour in (("entry", entry), ("exit", exit_)):
                    db.add(Movement(id=f"{subject_id}-{checkpoint}-{direction}", subject_id=subject_id,
                        checkpoint_id=checkpoint, subject_type="employee", direction=direction,
                        occurred_at=self.start + timedelta(hours=hour), result="approved",
                        scan_type="auto", sync_state="synced", data={}))
            for alert_id, data in (
                ("local-checkpoint", {"subjectId": "p1", "checkpointId": "cp-main"}),
                ("foreign-checkpoint", {"subjectId": "p1", "checkpointId": "b-1"}),
                ("foreign-zone", {"subjectId": "p1", "zoneId": "b"}),
                ("foreign-subject", {"subjectId": "foreign"}),
                ("unbound", {}),
            ):
                db.add(Alert(id=alert_id, created_at=self.start, data={"title": "Attendance irregularity", **data}))
            db.add(AlertReview(alert_id="retained-local", subject_id="p1", decision="confirmed", reason="Reviewed",
                reviewed_at=self.start, reviewed_by="fixture", alert_created_at=self.start,
                alert_data={"title": "Attendance irregularity", "checkpointId": "cp-main"}))
            db.add(AlertReview(alert_id="retained-foreign", subject_id="p1", decision="confirmed", reason="Reviewed",
                reviewed_at=self.start, reviewed_by="fixture", alert_created_at=self.start,
                alert_data={"title": "Attendance irregularity", "checkpointId": "b-1"}))
            await db.commit()
        self.authorize("only-a")

    async def asyncTearDown(self):
        import test_database as fixture
        await fixture.DatabaseTests.asyncTearDown(self)

    def authorize(self, subject, role="zone-admin"):
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": subject, "realm_access": {"roles": [role]},
        }

    async def test_scoped_details_summaries_and_aggregates_exclude_other_zone(self):
        params = {"days": 1, "endAt": self.end.isoformat()}
        detail = await self.client.get("/v1/movements/employee-activity", params={**params, "subjectId": "p1"})
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["totalHours"], 1)
        foreign = await self.client.get("/v1/movements/employee-activity", params={**params, "subjectId": "foreign"})
        self.assertEqual(foreign.status_code, 404, foreign.text)
        summary = await self.client.get("/v1/movements/employee-activity-summary", params=params)
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(summary.json()["averages"], {"p1": 1, "local": None})
        aggregate = await self.client.get("/v1/movements/dashboard-analytics", params={
            "startAt": self.start.isoformat(), "endAt": self.end.isoformat()})
        self.assertEqual(aggregate.status_code, 200, aggregate.text)
        current = aggregate.json()["current"]
        self.assertEqual(current["scanAnalytics"]["totalScans"], 2)
        self.assertEqual(current["scanAnalytics"]["activeInside"], 1)
        self.assertEqual(current["alertCount"], 2, "Foreign location must win over a currently shared subject")

    async def test_registry_profile_hours_and_sorting_use_only_scoped_transitions(self):
        from registry_reads import registry_page
        async with self.sessions() as db:
            for sort_key in ("name", "averageHours"):
                page = await registry_page(db, kind="employee", limit=25, offset=0, search=None,
                    days=365, sort_key=sort_key, sort_direction="asc", include_overview=True, zone_ids=("a",))
                self.assertNotIn("foreign", [person["id"] for person in page["people"]])
                self.assertAlmostEqual(page["averages"]["p1"], round(1 / 365, 2))
                self.assertEqual(page["activityDays"]["p1"][0]["workedHours"], 1)
                self.assertEqual(page["trend"]["value"], 1)

    async def test_master_admin_retains_activity_across_all_active_zones(self):
        self.authorize("master", "master-admin")
        summary = await self.client.get("/v1/movements/employee-activity-summary", params={
            "days": 1, "endAt": self.end.isoformat()})
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(summary.json()["averages"], {"p1": 5, "foreign": 5, "local": None})


if __name__ == "__main__":
    unittest.main()
