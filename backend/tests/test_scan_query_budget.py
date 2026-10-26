"""Scan query budgets, migration gates and optimistic alert revalidation."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import event, func, select
from sqlalchemy.exc import DBAPIError

import test_database as fixture
from alert_reviews import reset_subject_warnings
from critical_entry_restrictions import release_critical_entry_restriction
from models import Alert, AlertReview, AuditEvent, CriticalAlertTrigger, CriticalEntryRestriction, HardwareAsset, Person, PresenceState, Subject, WarningReset
from schemas import BrowserScanPayload
from terminal_scans import record_scan
from workflows.activities import run_alert_rule_evaluation


NOW = datetime(2026, 10, 10, 13, tzinfo=timezone.utc)


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class ScanQueryBudgetTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def _scan(self, *, hardware=(), barcode="p1", direction="entry"):
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode=barcode,
                checkpointId="cp-main", direction=direction, selectedHardwareIds=list(hardware)), "browser:operator")
            await db.commit()
            return result

    async def _legacy_reviews(self, subject_id, *, count=3, reviewed_at=NOW, gate=False):
        async with self.sessions() as db:
            subject = await db.get(Subject, subject_id)
            subject.warning_hold_materialized = gate
            for index in range(count):
                alert_id = f"legacy-{subject_id}-{index}"
                at = reviewed_at + timedelta(seconds=index)
                db.add(AlertReview(alert_id=alert_id, subject_id=subject_id, decision="confirmed", reason="",
                    reviewed_at=at, reviewed_by="legacy-admin", alert_created_at=at,
                    alert_data={"id": alert_id, "subjectId": subject_id}))
            await db.commit()

    async def test_presence_statement_count_is_constant_and_normal_scan_reads_no_warning_ledger(self):
        async with self.sessions() as db:
            for index in range(3):
                asset_id = f"carried-{index}"
                db.add(Subject(id=asset_id, kind="hardware", barcode=asset_id,
                    hardware=HardwareAsset(data={"name": asset_id, "status": "active", "allowedZones": ["All Zones"],
                        "inside": False, "assignedEmployeeId": "p1"})))
            await db.commit()
        statements = []
        def observe(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(statement.lower())
        event.listen(self.engine.sync_engine, "before_cursor_execute", observe)
        try:
            first = await self._scan()
            self.assertTrue(first["allowed"], first)
            first_presence = [sql for sql in statements if sql.startswith("insert into presence_state")
                or ("from presence_state" in sql and "for update" in sql)]
            self.assertEqual(len(first_presence), 2)
            self.assertFalse(any("alert_reviews" in sql or "warning_resets" in sql for sql in statements))
            # Exit the person and let the ordinary cooldown expire.
            async with self.sessions() as db:
                presence = await db.get(PresenceState, "p1")
                presence.state, presence.entry_building_id = "outside", None
                presence.last_scan_timestamp = None
                await db.commit()
            statements.clear()
            second = await self._scan(hardware=[f"carried-{index}" for index in range(3)])
            self.assertTrue(second["allowed"], second)
            second_presence = [sql for sql in statements if sql.startswith("insert into presence_state")
                or ("from presence_state" in sql and "for update" in sql)]
            self.assertEqual(len(second_presence), 2)
            self.assertFalse(any("alert_reviews" in sql or "warning_resets" in sql for sql in statements))
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", observe)

    async def test_unmaterialized_gate_repairs_once_and_release_and_reset_survive_scans(self):
        await self._legacy_reviews("p1")
        denied = await self._scan()
        self.assertFalse(denied["allowed"])
        async with self.sessions() as db:
            self.assertTrue((await db.get(Subject, "p1")).warning_hold_materialized)
            row = await db.get(CriticalEntryRestriction, "p1")
            self.assertTrue(row.active)
            await release_critical_entry_restriction(db, row.trigger_alert_id, "admin", "Checked historical warnings")
            await db.commit()
        with patch("critical_entry_restrictions.ensure_legacy_warning_threshold_restrictions",
                new=AsyncMock(side_effect=AssertionError("A materialized scan must not reconstruct warnings"))):
            self.assertTrue((await self._scan())["allowed"])
        async with self.sessions() as db:
            await reset_subject_warnings(db, "p1", "admin", "Reset after review")
            await db.commit()
            self.assertFalse((await db.get(CriticalEntryRestriction, "p1")).active)
            self.assertTrue((await db.get(Subject, "p1")).warning_hold_materialized)

    async def test_backfill_migration_respects_reset_epoch_release_and_preserves_history(self):
        async with self.sessions() as db:
            for subject_id in ("released", "reset", "later-threshold"):
                db.add(Subject(id=subject_id, kind="employee", barcode=subject_id,
                    person=Person(data={"name": subject_id, "status": "active"})))
            await db.commit()
        await self._legacy_reviews("p1")
        await self._legacy_reviews("released")
        await self._legacy_reviews("reset")
        await self._legacy_reviews("later-threshold")
        async with self.sessions() as db:
            db.add(WarningReset(subject_id="reset", reset_at=NOW + timedelta(minutes=1), reset_by="admin", reason="Reset"))
            db.add(CriticalEntryRestriction(subject_id="released", active=False, triggered_at=NOW - timedelta(days=1),
                trigger_alert_id="old-released", released_at=NOW + timedelta(minutes=1), released_by="admin", release_reason="Lifted"))
            db.add(CriticalEntryRestriction(subject_id="later-threshold", active=False, triggered_at=NOW - timedelta(days=2),
                trigger_alert_id="older-hold", released_at=NOW - timedelta(days=1), released_by="admin", release_reason="Earlier release"))
            await db.commit()
        async with self.engine.begin() as conn:
            def rerun(connection):
                revision = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic")).get_revision("b6c7d8e9f0").module
                with Operations.context(MigrationContext.configure(connection)):
                    revision.downgrade()
                    revision.upgrade()
            await conn.run_sync(rerun)
        async with self.sessions() as db:
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
            self.assertTrue((await db.get(CriticalEntryRestriction, "later-threshold")).active)
            self.assertFalse((await db.get(CriticalEntryRestriction, "released")).active)
            self.assertIsNone(await db.get(CriticalEntryRestriction, "reset"))
            self.assertTrue(all((await db.scalars(select(Subject.warning_hold_materialized))).all()))
            self.assertEqual(await db.scalar(select(func.count()).select_from(AlertReview)), 12)
            self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalAlertTrigger)), 2)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 2)

    async def test_concurrent_scans_with_overlapping_assets_serialize_without_partial_presence(self):
        await self._scan(hardware=["h1"])
        async with self.sessions() as db:
            for subject_id in ("p1", "h1"):
                presence = await db.get(PresenceState, subject_id)
                presence.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=20)
            await db.commit()
        results = await asyncio.wait_for(asyncio.gather(
            self._scan(hardware=["h1"], direction="exit"), self._scan(hardware=["h1"], direction="exit")), 10)
        self.assertEqual(sum(result["allowed"] for result in results), 1)
        async with self.sessions() as db:
            self.assertEqual({presence.state for presence in (await db.scalars(select(PresenceState))).all()}, {"outside"})

    async def test_backfill_conflicting_trigger_rolls_back_without_publishing_gate(self):
        await self._legacy_reviews("p1")
        async with self.sessions() as db:
            db.add(CriticalAlertTrigger(alert_id="legacy-p1-2", subject_id="h1", triggered_at=NOW))
            await db.commit()
        with self.assertRaises(DBAPIError):
            async with self.engine.begin() as conn:
                def rerun(connection):
                    revision = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic")).get_revision("b6c7d8e9f0").module
                    with Operations.context(MigrationContext.configure(connection)):
                        revision.downgrade()
                        revision.upgrade()
                await conn.run_sync(rerun)
        async with self.sessions() as db:
            self.assertFalse((await db.get(Subject, "p1")).warning_hold_materialized)
            self.assertIsNone(await db.get(CriticalEntryRestriction, "p1"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 0)

    async def test_no_candidate_evaluation_does_not_lock_or_wait_for_unrelated_scan(self):
        async with self.sessions() as scan:
            await scan.scalar(select(Subject.id).where(Subject.id == "p1").with_for_update())
            with patch("workflows.activities.async_session", self.sessions), \
                 patch("workflows.activities.datetime", wraps=datetime) as clock:
                clock.now.return_value = NOW.replace(hour=9)
                self.assertEqual(await asyncio.wait_for(run_alert_rule_evaluation(), 5), 0)

    async def test_candidate_is_recomputed_after_concurrent_valid_entry_before_lock(self):
        from rule_engine import evaluate_scheduled_rules
        calls = 0
        entry_committed = False

        def candidate_rules(*args, **kwargs):
            nonlocal calls
            calls += 1
            return evaluate_scheduled_rules(*args, **kwargs)

        # Start a real scan after optimistic candidate computation and await its
        # commit immediately before the evaluator's candidate lock statement.
        scan_task = None
        def start_scan(*args, **kwargs):
            nonlocal scan_task
            if scan_task is None:
                scan_task = asyncio.create_task(self._scan())
            return candidate_rules(*args, **kwargs)
        from sqlalchemy.ext.asyncio import AsyncSession
        execute = AsyncSession.execute

        async def intercept(session, statement, *args, **kwargs):
            nonlocal entry_committed
            lock = getattr(statement, "_for_update_arg", None)
            if scan_task is not None and not entry_committed and lock is not None and lock.nowait:
                result = await scan_task
                self.assertTrue(result["allowed"])
                entry_committed = True
            return await execute(session, statement, *args, **kwargs)

        with patch("workflows.activities.async_session", self.sessions), \
             patch("workflows.activities.datetime", wraps=datetime) as clock, \
             patch("terminal_scans.datetime", wraps=datetime) as scan_clock, \
             patch("rule_engine.evaluate_scheduled_rules", new=start_scan), \
             patch.object(AsyncSession, "execute", new=intercept):
            clock.now.return_value = NOW
            scan_clock.now.return_value = NOW
            self.assertEqual(await asyncio.wait_for(run_alert_rule_evaluation(), 10), 0)
        self.assertTrue(entry_committed)
        self.assertEqual(calls, 2)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)
