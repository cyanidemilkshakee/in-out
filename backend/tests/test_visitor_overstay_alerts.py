"""Continuous visitor visits use current presence and durable alert deduplication."""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from sqlalchemy import delete, func, select

import test_database as fixture
from models import Alert, AlertRule, AlertRuleAssignment, Person, PresenceState, Subject
from rule_engine import default_alert_rules, evaluate_visitor_overstay_rules
from schemas import BrowserScanPayload
from seed import seed_reference_data
from terminal_scans import record_scan
from workflows.activities import run_alert_rule_evaluation


NOW = datetime(2026, 10, 10, 9, tzinfo=timezone.utc)


class VisitorOverstayRuleTests(unittest.TestCase):
    def _visit(self, **changes):
        return {"subjectId": "visitor", "subjectType": "visitor", "state": "inside",
                "subjectName": "Guest", "barcode": "VISITOR", "buildingId": "main-building",
                "entryStartedAt": NOW - timedelta(hours=13), "alertedEntryAt": None, **changes}

    def test_unknown_malformed_future_and_nonvisitor_starts_are_not_invented(self):
        for changes in ({"entryStartedAt": None}, {"entryStartedAt": "2026-10-09T09:00:00Z"},
                        {"entryStartedAt": 123}, {"entryStartedAt": (NOW - timedelta(hours=13)).replace(tzinfo=None)},
                        {"entryStartedAt": NOW + timedelta(hours=1)}, {"subjectType": "employee"},
                        {"state": "outside"}, {"subjectId": ""}):
            with self.subTest(changes=changes):
                self.assertEqual(evaluate_visitor_overstay_rules(default_alert_rules(),
                    [self._visit(**changes)], now=NOW), [])

    def test_offsets_identify_the_same_visit_and_marker_suppresses_it(self):
        start = NOW - timedelta(hours=13)
        local_start = start.astimezone(timezone(timedelta(hours=5, minutes=30)))
        first = evaluate_visitor_overstay_rules(default_alert_rules(), [self._visit(entryStartedAt=start)], now=NOW)
        local = evaluate_visitor_overstay_rules(default_alert_rules(), [self._visit(entryStartedAt=local_start)], now=NOW)
        self.assertEqual(first[0]["id"], local[0]["id"])
        self.assertEqual(first[0]["entryStartedAt"], start.isoformat())
        self.assertEqual(evaluate_visitor_overstay_rules(default_alert_rules(),
            [self._visit(entryStartedAt=local_start, alertedEntryAt=start)], now=NOW), [])


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class VisitorOverstayDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def _visitor(self, subject_id="visitor", *, state="inside", building="main-building",
                       started_at=None, status="pre_approved", metadata_inside=False):
        async with self.sessions() as db:
            db.add(Subject(id=subject_id, kind="visitor", barcode=subject_id, person=Person(data={
                "name": "Guest " + subject_id, "status": status, "allowedZones": ["public", "secure"],
                "inside": metadata_inside, "validTo": "2020-01-01T00:00:00Z" if status == "expired" else ""})))
            await db.flush()
            db.add(PresenceState(subject_id=subject_id, state=state, entry_building_id=building,
                last_scan_timestamp=started_at, entry_started_at=started_at))
            await db.commit()

    async def _evaluate(self, now=NOW):
        with patch("workflows.activities.async_session", new=self.sessions), \
             patch("workflows.activities.datetime", wraps=datetime) as clock:
            clock.now.return_value = now
            return await run_alert_rule_evaluation()

    async def _record(self, at, *, direction, checkpoint="cp-main", subject_id="visitor"):
        with patch("terminal_scans.datetime", wraps=datetime) as clock:
            clock.now.return_value = at
            async with self.sessions() as db:
                result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(
                    barcode=subject_id, checkpointId=checkpoint, direction=direction), "browser:test-operator")
                await db.commit()
        self.assertTrue(result["allowed"], result)
        return result

    async def _assert_unalerted(self, subject_id="visitor"):
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)
            self.assertIsNone((await db.get(PresenceState, subject_id)).visitor_overstay_alerted_entry_at)

    async def test_strict_twelve_hour_boundary_and_both_buildings(self):
        started_at = NOW - timedelta(hours=12)
        await self._visitor("main-visitor", started_at=started_at)
        await self._visitor("secure-visitor", building="server-room-building", started_at=started_at)
        self.assertEqual(await self._evaluate(), 0)
        self.assertEqual(await self._evaluate(NOW + timedelta(microseconds=1)), 2)
        self.assertEqual(await self._evaluate(NOW + timedelta(hours=1)), 0)
        async with self.sessions() as db:
            alerts = (await db.scalars(select(Alert))).all()
            self.assertEqual({row.data["entryBuildingId"] for row in alerts},
                {"main-building", "server-room-building"})
            self.assertEqual({row.data["checkpoint"] for row in alerts}, {"Main Entrance", "Server Room"})
            self.assertTrue(all(row.data["subjectType"] == "visitor" for row in alerts))
            self.assertTrue(all(row.source_event_id is None for row in alerts))

    async def test_current_presence_overrides_metadata_status_and_assignments(self):
        for status in ("expired", "inactive", "restricted"):
            await self._visitor(status, started_at=NOW - timedelta(hours=13), status=status)
        await self._visitor("actually-outside", state="outside", started_at=NOW - timedelta(days=5), metadata_inside=True)
        async with self.sessions() as db:
            # Visitor rules remain global even if legacy data contains a custom
            # selection; the current UI only assigns attendance rules to staff.
            db.add(AlertRuleAssignment(subject_id="expired", rule_ids=[], rules_customized=True,
                revision=1, updated_by="test-admin"))
            await db.commit()
        self.assertEqual(await self._evaluate(), 3)
        async with self.sessions() as db:
            alerts = (await db.scalars(select(Alert))).all()
            self.assertEqual({row.data["subjectId"] for row in alerts}, {"expired", "inactive", "restricted"})
            self.assertIsNone((await db.get(PresenceState, "actually-outside")).visitor_overstay_alerted_entry_at)

    async def test_old_live_visit_and_alert_retention_never_retrigger_same_visit(self):
        started_at = NOW - timedelta(days=5)
        await self._visitor(started_at=started_at)
        self.assertEqual(await self._evaluate(), 1)
        self.assertEqual(await self._evaluate(NOW + timedelta(days=3)), 0)
        async with self.sessions() as db:
            alert = await db.scalar(select(Alert))
            alert.data = {**alert.data, "status": "acknowledged"}
            await db.commit()
        self.assertEqual(await self._evaluate(NOW + timedelta(days=3)), 0)
        async with self.sessions() as db:
            await db.execute(delete(Alert))
            await db.commit()
        self.assertEqual(await self._evaluate(NOW + timedelta(days=3)), 0)
        async with self.sessions() as db:
            self.assertEqual((await db.get(PresenceState, "visitor")).visitor_overstay_alerted_entry_at, started_at)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)

    async def test_actual_exit_and_reentry_reset_the_visit_and_allow_one_new_alert(self):
        entry = NOW - timedelta(hours=13)
        await self._visitor(state="outside")
        async with self.sessions() as db:
            # This test crosses the attendance cutoff; disable only the
            # unrelated fixture employee's assigned attendance rules.
            db.add(AlertRuleAssignment(subject_id="p1", rule_ids=[], rules_customized=True,
                revision=1, updated_by="test-admin"))
            await db.commit()
        await self._record(entry, direction="entry")
        self.assertEqual(await self._evaluate(), 1)
        exit_at = NOW + timedelta(minutes=1)
        await self._record(exit_at, direction="exit")
        async with self.sessions() as db:
            presence = await db.get(PresenceState, "visitor")
            self.assertIsNone(presence.entry_started_at)
            self.assertIsNone(presence.visitor_overstay_alerted_entry_at)
        self.assertEqual(await self._evaluate(exit_at), 0)
        reentry = NOW + timedelta(minutes=2)
        await self._record(reentry, direction="entry", checkpoint="server-room")
        self.assertEqual(await self._evaluate(reentry + timedelta(hours=12)), 0)
        self.assertEqual(await self._evaluate(reentry + timedelta(hours=12, microseconds=1)), 1)
        self.assertEqual(await self._evaluate(reentry + timedelta(hours=13)), 0)
        async with self.sessions() as db:
            alerts = (await db.scalars(select(Alert))).all()
            self.assertEqual(len({row.id for row in alerts}), 2)
            self.assertEqual({row.data["entryStartedAt"] for row in alerts}, {entry.isoformat(), reentry.isoformat()})
            presence = await db.get(PresenceState, "visitor")
            self.assertEqual(presence.entry_started_at, reentry)
            self.assertEqual(presence.visitor_overstay_alerted_entry_at, reentry)

    async def test_disabled_stored_global_rule_suppresses_default_without_marking_visit(self):
        await self._visitor(started_at=NOW - timedelta(hours=13))
        rule = next(row for row in default_alert_rules() if row["conditionKey"] == "visitor_overstay")
        async with self.sessions() as db:
            db.add(AlertRule(id="custom-visitor-policy", data={**rule, "id": "custom-visitor-policy", "enabled": False}))
            await db.commit()
        self.assertEqual(await self._evaluate(), 0)
        await self._assert_unalerted()
        async with self.sessions() as db:
            stored = await db.get(AlertRule, "custom-visitor-policy")
            stored.data = {**stored.data, "enabled": True}
            await db.commit()
        self.assertEqual(await self._evaluate(), 1)

    async def test_unknown_and_future_current_visit_starts_do_not_raise_alerts(self):
        await self._visitor("unknown")
        await self._visitor("future", started_at=NOW + timedelta(hours=1))
        self.assertEqual(await self._evaluate(), 0)
        await self._assert_unalerted("unknown")
        await self._assert_unalerted("future")

    async def test_seeding_preserves_an_existing_same_condition_global_override(self):
        await self._visitor(started_at=NOW - timedelta(hours=13))
        rule = next(item for item in default_alert_rules() if item["conditionKey"] == "visitor_overstay")
        async with self.sessions() as db:
            db.add(AlertRule(id="existing-visitor-policy", data={**rule, "enabled": False}))
            await db.commit()
        await seed_reference_data(self.engine)
        async with self.sessions() as db:
            self.assertIsNone(await db.get(AlertRule, "rule-visitor-overstay"))
        self.assertEqual(await self._evaluate(), 0)
        await self._assert_unalerted()

    async def test_capacity_counts_live_visitors_and_ignores_historical_outside_roster(self):
        from config import settings

        await self._visitor(started_at=NOW - timedelta(hours=13))
        async with self.sessions() as db:
            for index in range(5):
                subject_id = f"outside-{index}"
                db.add(Subject(id=subject_id, kind="visitor", barcode=subject_id,
                    person=Person(data={"name": "Old guest", "inside": True})))
                await db.flush()
                db.add(PresenceState(subject_id=subject_id, state="outside"))
            await db.commit()
        with patch.object(settings, "ALERT_EVALUATION_MAX_SUBJECTS", 2):
            with self.assertRaises(HTTPException) as error:
                await self._evaluate()
            self.assertEqual(error.exception.detail["code"], "alert_evaluation_capacity_exceeded")
            self.assertEqual(error.exception.detail["resource"], "subjects")
        await self._assert_unalerted()
        # The fixture has exactly three relevant subjects: employee, hardware
        # and one currently inside visitor. Outside history must not fill this cap.
        with patch.object(settings, "ALERT_EVALUATION_MAX_SUBJECTS", 3):
            self.assertEqual(await self._evaluate(), 1)

    async def test_busy_subject_rolls_back_earlier_subject_locks_without_marking_visit(self):
        await self._visitor("z-visitor", started_at=NOW - timedelta(hours=13))
        async with self.sessions() as scan:
            await scan.scalar(select(Subject).where(Subject.id == "z-visitor").with_for_update())
            with self.assertRaises(HTTPException) as error:
                await asyncio.wait_for(self._evaluate(), 5)
            self.assertEqual(error.exception.status_code, 503)
            self.assertEqual(error.exception.detail["code"], "alert_evaluation_busy")
            # An evaluator may lock earlier IDs first, but its failed attempt
            # must release them and leave the visitor marker untouched.
            async with self.sessions() as other:
                await other.scalar(select(Subject).where(Subject.id == "h1").with_for_update(nowait=True))
                await other.rollback()
            await scan.rollback()
        await self._assert_unalerted("z-visitor")
        self.assertEqual(await self._evaluate(), 1)

    async def test_concurrent_evaluator_is_rejected_and_retry_does_not_duplicate_alert(self):
        from critical_entry_restrictions import activate_critical_entry_restrictions

        await self._visitor(started_at=NOW - timedelta(hours=13))
        ready, release = asyncio.Event(), asyncio.Event()

        async def pause_before_commit(db, rows):
            ready.set()
            await release.wait()
            return await activate_critical_entry_restrictions(db, rows)

        with patch("critical_entry_restrictions.activate_critical_entry_restrictions", new=pause_before_commit):
            first = asyncio.create_task(self._evaluate())
            try:
                await asyncio.wait_for(ready.wait(), 5)
                with self.assertRaises(HTTPException) as error:
                    await asyncio.wait_for(self._evaluate(), 5)
                self.assertEqual(error.exception.detail["code"], "alert_evaluation_busy")
                release.set()
                self.assertEqual(await asyncio.wait_for(first, 5), 1)
            finally:
                release.set()
                if not first.done():
                    first.cancel()
                    await asyncio.gather(first, return_exceptions=True)
        self.assertEqual(await self._evaluate(), 0)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 1)

    async def test_failure_before_commit_rolls_back_alert_and_durable_marker_together(self):
        await self._visitor(started_at=NOW - timedelta(hours=13))
        with patch("critical_entry_restrictions.activate_critical_entry_restrictions",
                   new=AsyncMock(side_effect=RuntimeError("simulated persistence failure"))):
            with self.assertRaisesRegex(RuntimeError, "simulated persistence failure"):
                await self._evaluate()
        await self._assert_unalerted()
        self.assertEqual(await self._evaluate(), 1)

    async def test_seed_registers_four_rules_and_preserves_disabled_policy(self):
        rule = next(row for row in default_alert_rules() if row["conditionKey"] == "visitor_overstay")
        async with self.sessions() as db:
            db.add(AlertRule(id=rule["id"], data={**rule, "enabled": False}))
            await db.commit()
        await seed_reference_data(self.engine)
        await seed_reference_data(self.engine)
        async with self.sessions() as db:
            rows = (await db.scalars(select(AlertRule))).all()
            expected = {rule["id"] for rule in default_alert_rules()}
            self.assertEqual(len(expected), 4)
            self.assertEqual({row.id for row in rows}, expected)
            self.assertFalse((await db.get(AlertRule, rule["id"])).data["enabled"])

    async def test_migration_uses_conservative_last_scan_and_leaves_unknown_outside_starts_empty(self):
        await self._visitor("inside", started_at=NOW - timedelta(hours=2))
        await self._visitor("unknown")
        await self._visitor("outside", state="outside", started_at=NOW - timedelta(days=1))
        async with self.engine.begin() as conn:
            def remigrate(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                revision = scripts.get_revision("z4a5b6c7d8")
                with Operations.context(MigrationContext.configure(connection)):
                    revision.module.downgrade()
                    revision.module.upgrade()
            await conn.run_sync(remigrate)
        async with self.sessions() as db:
            inside = await db.get(PresenceState, "inside")
            self.assertEqual(inside.entry_started_at, inside.last_scan_timestamp)
            for subject_id in ("unknown", "outside"):
                self.assertIsNone((await db.get(PresenceState, subject_id)).entry_started_at)
            self.assertTrue(all(row.visitor_overstay_alerted_entry_at is None
                for row in (await db.scalars(select(PresenceState))).all()))


if __name__ == "__main__":
    unittest.main()
