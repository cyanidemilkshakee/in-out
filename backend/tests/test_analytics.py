"""Complete period aggregates and boundary-safe employee sessions on isolated PostgreSQL."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from sqlalchemy import select

import test_database as fixtures
from auth import verify_admin_request
from models import Alert, AlertReview, Movement, PermissionRequestModel
from movement_analytics import build_activity_days

UTC = timezone.utc


class ActivityBoundaryTests(unittest.TestCase):
    def test_overnight_and_open_sessions_are_clipped_at_facility_midnight(self):
        start = datetime(2026, 9, 9, 18, 30, tzinfo=UTC)  # Sep 10 midnight
        end = start + timedelta(days=1, hours=3)
        events = [("entry", start - timedelta(hours=2)), ("entry", start + timedelta(hours=1)),
            ("exit", start + timedelta(hours=2)), ("entry", start + timedelta(hours=22))]
        days = build_activity_days(events, start, end)
        self.assertEqual([day["date"] for day in days], ["2026-09-10", "2026-09-11"])
        self.assertAlmostEqual(days[0]["workedHours"], 4)
        self.assertAlmostEqual(days[1]["workedHours"], 3)
        self.assertEqual([(session["start"], session["end"]) for session in days[0]["sessions"]], [(0, 2), (22, 24)])
        # Events after a comparison period may close its session without extending the total.
        previous = build_activity_days(events, start, start + timedelta(hours=1))
        self.assertAlmostEqual(sum(day["workedHours"] for day in previous), 1)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class AnalyticsDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixtures.DatabaseTests.asyncSetUp(self)
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "analytics-admin"}

    async def asyncTearDown(self):
        await fixtures.DatabaseTests.asyncTearDown(self)

    def movement(self, event_id, at, *, result="approved", scan_type="auto", direction="entry", code=None, subject_id="p1", subject_type="employee", data=None):
        return Movement(id=event_id, subject_id=subject_id, checkpoint_id="cp-main", occurred_at=at,
            result=result, direction=direction, scan_type=scan_type, denial_code=code,
            subject_type=subject_type, sync_state="synced", data=data or {"subjectName": "Alice", "barcode": subject_id})

    async def test_full_current_previous_breakdowns_and_alert_history_exceed_preview_limits(self):
        start = datetime(2026, 9, 10, tzinfo=UTC)
        end = start + timedelta(days=1) - timedelta(milliseconds=1)
        cases = [
            ("approved", "auto", "entry", None), ("approved", "auto", "exit", None),
            ("approved", "manual", "entry", None), ("approved", "manual", "exit", None),
            ("denied", "auto", "entry", "zone_not_permitted"), ("denied", "manual", "entry", "access_restricted"),
            ("denied", "auto", "entry", "expired_pass"), ("denied", "manual", "entry", "expired_pass"),
            ("denied", "auto", "entry", "barcode_not_registered"), ("denied", "manual", "entry", "manual_review"),
            ("denied", "auto", "entry", None), ("denied", "manual", "entry", None),
        ]
        async with self.sessions() as db:
            for index in range(600):
                result, scan_type, direction, code = cases[index % 12]
                db.add(self.movement(f"current-{index}", start + timedelta(seconds=index), result=result,
                    scan_type=scan_type, direction=direction, code=code))
            for index in range(30):
                db.add(self.movement(f"previous-{index}", start - timedelta(hours=1, seconds=index),
                    result="approved" if index < 20 else "denied"))
            db.add(self.movement("hardware", start, subject_id="h1", subject_type="hardware"))
            for index in range(15):
                db.add(Alert(id=f"live-{index}", created_at=start, data={"subjectId": "p1", "title": "Attendance irregularity", "status": "acknowledged"}))
            for index in range(6):
                # live-0 and its review count once; the other five survive source retention.
                db.add(AlertReview(alert_id="live-0" if index == 0 else f"retained-{index}", subject_id="p1",
                    decision="confirmed", reason="Confirmed", reviewed_at=start, reviewed_by="admin",
                    alert_created_at=start, alert_data={"subjectId": "p1", "title": "No break recorded"}))
            db.add(Alert(id="previous-alert", created_at=start - timedelta(hours=1), data={"subjectId": "p1", "title": "No break recorded"}))
            db.add(Alert(id="excluded", created_at=start, data={"subjectId": "p1", "title": "Unknown barcode", "ruleId": "rule-unknown-barcode"}))
            db.add(Alert(id="hardware-alert", created_at=start, data={"subjectId": "h1", "title": "Hardware policy"}))
            await db.commit()
        params = {"startAt": start.isoformat(), "endAt": end.isoformat(), "subjectGroup": "people"}
        response = await self.client.get("/v1/movements/dashboard-analytics", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        current, previous = response.json()["current"], response.json()["previous"]
        self.assertEqual(current["scanAnalytics"], {"totalScans": 600, "totalApproved": 200, "totalDenied": 400,
            "totalEntries": 100, "totalExits": 100, "totalAutomatic": 300, "totalManual": 300,
            "totalRestricted": 200, "totalOtherDenied": 200, "activeInside": 0})
        self.assertEqual(current["breakdown"]["otherAuto"], 100)
        self.assertEqual(current["breakdown"]["restrictedManual"], 100)
        self.assertEqual(current["alertCount"], 20)
        self.assertEqual(previous["scanAnalytics"]["totalScans"], 30)
        self.assertEqual(previous["scanAnalytics"]["totalApproved"], 20)
        self.assertEqual(previous["alertCount"], 1)
        hardware = (await self.client.get("/v1/movements/dashboard-analytics", params={**params, "subjectGroup": "hardware"})).json()
        self.assertEqual(hardware["current"]["scanAnalytics"]["totalScans"], 1)
        self.assertEqual(hardware["current"]["alertCount"], 1)
        lifetime = (await self.client.get("/v1/movements/dashboard-analytics", params={"endAt": end.isoformat()})).json()
        self.assertIsNone(lifetime["previous"])
        self.assertEqual(lifetime["current"]["scanAnalytics"]["totalScans"], 630)

    async def test_exact_denial_categories_and_date_bounds_match_drilldowns(self):
        start = datetime(2026, 9, 10, tzinfo=UTC)
        async with self.sessions() as db:
            db.add_all([
                self.movement("restricted", start, result="denied", code="zone_not_permitted", data={"reason": "Checkpoint zone not permitted"}),
                self.movement("expired", start, result="denied", code="expired_pass"),
                self.movement("other", start, result="denied", code=None, data={"subjectName": "Restricted Guest"}),
                self.movement("old-other", start - timedelta(days=10), result="denied", code=None),
                self.movement("approved", start),
            ])
            await db.commit()
        expected = {"restricted": {"restricted", "expired"}, "other": {"other"}}
        for category, expected_ids in expected.items():
            params = {"denialCategory": category, "startAt": start.isoformat(), "endAt": start.isoformat()}
            for endpoint in ("/v1/movements", "/v1/movements/analytics"):
                response = await self.client.get(endpoint, params=params)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual({row["id"] for row in response.json()["items"]}, expected_ids)
        self.assertEqual((await self.client.get("/v1/movements", params={"denialCategory": "expired"})).status_code, 422)
        self.assertEqual((await self.client.get("/v1/movements", params={"denialCategory": "unknown"})).status_code, 422)
        self.assertEqual((await self.client.get("/v1/movements/dashboard-analytics", params={"startAt": "bad"})).status_code, 422)
        self.assertEqual((await self.client.get("/v1/movements/dashboard-analytics", params={"startAt": "2026-09-11", "endAt": "2026-09-10"})).status_code, 422)

    async def test_legacy_replacement_dedup_keeps_direct_source_links_and_authoritative_revisions(self):
        start = datetime(2026, 9, 10, tzinfo=UTC)
        async with self.sessions() as db:
            db.add(self.movement("source", start, result="denied", code="access_restricted"))
            db.add(self.movement("replacement", start, scan_type="manual", data={"overrideRequestId": "review", "result": "denied", "scanType": "auto"}))
            db.add(self.movement("manual-denial", start, result="denied", scan_type="manual", code="manual_review",
                data={"initialScanType": "auto", "scanType": "auto"}))
            db.add(PermissionRequestModel(id="review", subject_id="p1", created_at=start,
                data={"type": "manual_override", "eventId": "source", "status": "approved"}))
            await db.commit()
        analytics = (await self.client.get("/v1/movements/dashboard-analytics", params={"startAt": start.isoformat(), "endAt": start.isoformat()})).json()["current"]["scanAnalytics"]
        self.assertEqual((analytics["totalScans"], analytics["totalManual"], analytics["totalApproved"], analytics["totalDenied"]), (2, 2, 1, 1))
        page = (await self.client.get("/v1/movements")).json()
        self.assertEqual(page["total"], 2)
        for endpoint in ("/v1/movements", "/v1/movements/analytics"):
            response = await self.client.get(endpoint, params={"eventId": "source", "subjectGroup": "hardware", "startAt": "2099-01-01", "denialCategory": "other"})
            self.assertEqual([row["id"] for row in response.json()["items"]], ["source"])

    async def test_employee_complete_ranges_ignore_other_subjects_denials_and_carry_boundary_entry(self):
        end = datetime(2026, 9, 10, 6, 30, tzinfo=UTC)  # facility noon
        start = datetime(2026, 9, 3, 18, 30, tzinfo=UTC)  # Sep 4 midnight, 7 days
        async with self.sessions() as db:
            db.add_all([
                self.movement("seed", start - timedelta(days=7, hours=1)),
                self.movement("prior-exit", start - timedelta(days=6, hours=22), direction="exit"),
                self.movement("boundary-entry", start - timedelta(hours=1)),
                self.movement("boundary-exit", start + timedelta(hours=2), direction="exit"),
                self.movement("denied-entry", start + timedelta(hours=3), result="denied"),
                self.movement("other-subject", start, subject_id="h1", subject_type="hardware"),
                self.movement("open", end - timedelta(hours=3)),
            ])
            # 620 movements exceed every previous 8/100/500 preview. 310 one-minute sessions.
            for index in range(310):
                timestamp = start + timedelta(days=1, minutes=index * 2)
                db.add(self.movement(f"entry-{index}", timestamp))
                db.add(self.movement(f"exit-{index}", timestamp + timedelta(minutes=1), direction="exit"))
            await db.commit()
        response = await self.client.get("/v1/movements/employee-activity", params={"subjectId": "p1", "days": 7, "endAt": end.isoformat()})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertAlmostEqual(data["totalHours"], 2 + 310 / 60 + 3)
        self.assertAlmostEqual(data["previousTotalHours"], 2)
        self.assertEqual(data["days"][0]["date"], "2026-09-04")
        for days in (30, 365):
            page = await self.client.get("/v1/movements/employee-activity", params={"subjectId": "p1", "days": days, "endAt": end.isoformat()})
            self.assertEqual(page.status_code, 200, page.text)
            self.assertGreater(page.json()["totalHours"], data["totalHours"])
        self.assertEqual((await self.client.get("/v1/movements/employee-activity", params={"subjectId": "h1"})).status_code, 404)
        self.assertEqual((await self.client.get("/v1/movements/employee-activity", params={"subjectId": "p1", "days": 1000})).status_code, 422)
        async with self.sessions() as db:
            self.assertEqual(len((await db.scalars(select(Movement))).all()), 627)
