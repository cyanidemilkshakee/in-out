"""Retention stays explicit, bounded and evidence-aware across short transactions."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import event, select
from sqlalchemy.dialects import postgresql

import maintenance
from models import Alert, Movement, PermissionRequestModel, ScanRequest
import test_database as fixture


MOVEMENTS = (("movements", Movement, "occurred_at", "MOVEMENT_RETENTION_DAYS"),)


def session(*, candidates=(), deleted=(), count=0):
    return SimpleNamespace(scalar=AsyncMock(return_value=count),
        scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: list(candidates))),
        execute=AsyncMock(return_value=SimpleNamespace(all=lambda: list(deleted))), commit=AsyncMock())


def factory(*sessions):
    pending = iter(sessions)

    @asynccontextmanager
    async def transaction():
        yield next(pending)

    return Mock(side_effect=transaction)


class MaintenanceBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_dry_run_retains_exact_count_without_deletes_or_commits(self):
        db = session(count=1234)
        with patch.object(maintenance, "RETENTION_TARGETS", MOVEMENTS), \
             patch.object(maintenance.settings, "MOVEMENT_RETENTION_DAYS", 1), \
             patch.object(maintenance, "async_session", factory(db)):
            self.assertEqual(await maintenance.cleanup(apply=False), {"movements": 1234})
        sql = str(db.scalar.await_args.args[0].compile(dialect=postgresql.dialect()))
        self.assertIn("count(*)", sql)
        self.assertIn("alerts.source_event_id = movements.id", sql)
        self.assertIn("permission_requests.data", sql)
        db.scalars.assert_not_awaited()
        db.execute.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_batches_commit_independently_recheck_evidence_and_count_actual_deletes(self):
        # One candidate gains evidence between SELECT and DELETE; a later
        # entire batch gains evidence. Neither may inflate the reported total
        # or prevent a subsequent eligible batch from being processed.
        ids = [f"old-{index}" for index in range(500)]
        first = session(candidates=ids, deleted=[(identity,) for identity in ids[:-1]])
        protected = session(candidates=["new-evidence"], deleted=[])
        last = session(candidates=["later"], deleted=[("later",)])
        empty = session()
        sessions = factory(first, protected, last, empty)
        with patch.object(maintenance, "RETENTION_TARGETS", MOVEMENTS), \
             patch.object(maintenance.settings, "MOVEMENT_RETENTION_DAYS", 1), \
             patch.object(maintenance, "async_session", sessions):
            self.assertEqual(await maintenance.cleanup(apply=True), {"movements": 500})
        self.assertEqual(sessions.call_count, 4)
        for db in (first, protected, last):
            db.scalar.assert_not_awaited()  # Applying needs no full-table count.
            db.commit.assert_awaited_once()
            candidates = db.scalars.await_args.args[0]
            self.assertEqual(candidates._limit_clause.value, 500)
            self.assertTrue(candidates._for_update_arg.skip_locked)
            self.assertEqual(str(candidates._order_by_clauses[0]), "movements.occurred_at")
            deletion = str(db.execute.await_args.args[0].compile(dialect=postgresql.dialect()))
            self.assertIn("RETURNING movements.id", deletion)
            self.assertIn("movements.occurred_at <", deletion)
            self.assertIn("alerts.source_event_id = movements.id", deletion)
            self.assertIn("permission_requests.data", deletion)
        empty.execute.assert_not_awaited()
        empty.commit.assert_not_awaited()

    async def test_idempotency_retention_uses_the_real_uuid_primary_key(self):
        identity = uuid.uuid4()
        db, empty = session(candidates=[identity], deleted=[(identity,)]), session()
        targets = (("idempotency requests", ScanRequest, "created_at", "IDEMPOTENCY_RETENTION_DAYS"),)
        with patch.object(maintenance, "RETENTION_TARGETS", targets), \
             patch.object(maintenance.settings, "IDEMPOTENCY_RETENTION_DAYS", 30), \
             patch.object(maintenance, "async_session", factory(db, empty)):
            self.assertEqual(await maintenance.cleanup(apply=True), {"idempotency requests": 1})
        query = db.execute.await_args.args[0]
        compiled = query.compile(dialect=postgresql.dialect())
        self.assertIn("RETURNING scan_requests.idempotency_key", str(compiled))
        self.assertIn([identity], compiled.params.values())

    async def test_disabled_retention_never_opens_a_session(self):
        with patch.object(maintenance, "RETENTION_TARGETS", MOVEMENTS), \
             patch.object(maintenance.settings, "MOVEMENT_RETENTION_DAYS", 0), \
             patch.object(maintenance, "async_session") as sessions:
            self.assertEqual(await maintenance.cleanup(apply=True), {})
        sessions.assert_not_called()

    async def test_later_batch_failure_does_not_reopen_or_recommit_previous_batches(self):
        first, failed = session(candidates=["first"], deleted=[("first",)]), session(candidates=["failed"], deleted=[("failed",)])
        failed.commit.side_effect = RuntimeError("isolated commit failure")
        with patch.object(maintenance, "RETENTION_TARGETS", MOVEMENTS), \
             patch.object(maintenance.settings, "MOVEMENT_RETENTION_DAYS", 1), \
             patch.object(maintenance, "async_session", factory(first, failed)):
            with self.assertRaisesRegex(RuntimeError, "isolated commit failure"):
                await maintenance.cleanup(apply=True)
        first.commit.assert_awaited_once()
        failed.commit.assert_awaited_once()


class MaintenanceCommandTests(unittest.TestCase):
    def test_command_defaults_to_dry_run_and_requires_explicit_apply(self):
        for extra, apply in (([], False), (["--apply"], True)):
            with self.subTest(apply=apply), patch.object(sys, "argv", ["maintenance", "cleanup", *extra]), \
                 patch.object(maintenance, "main_async", new=AsyncMock()) as run:
                maintenance.main()
                run.assert_awaited_once_with(apply)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class MaintenanceBatchDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def test_more_than_one_batch_preserves_both_evidence_types_and_recent_movements(self):
        old, recent = datetime.now(timezone.utc) - timedelta(days=10), datetime.now(timezone.utc)
        async with self.sessions() as db:
            for index in range(501):
                db.add(Movement(id=f"ret-old-{index}", checkpoint_id="cp-main", occurred_at=old,
                    result="denied", direction="entry", scan_type="auto", subject_type="employee", data={}))
            for identity, occurred_at in (("ret-alert", old), ("ret-review", old), ("ret-recent", recent)):
                db.add(Movement(id=identity, checkpoint_id="cp-main", occurred_at=occurred_at,
                    result="denied", direction="entry", scan_type="auto", subject_type="employee", data={}))
            await db.flush()
            db.add(Alert(id="ret-evidence", source_event_id="ret-alert", data={"status": "open"}))
            db.add(PermissionRequestModel(id="ret-review-request", data={"eventId": "ret-review"}))
            await db.commit()
        commits = []
        def committed(_connection):
            commits.append(True)
        event.listen(self.engine.sync_engine, "commit", committed)
        try:
            with patch.object(maintenance, "RETENTION_TARGETS", MOVEMENTS), \
                 patch.object(maintenance.settings, "MOVEMENT_RETENTION_DAYS", 1), \
                 patch.object(maintenance, "async_session", self.sessions):
                self.assertEqual(await maintenance.cleanup(apply=False), {"movements": 501})
                self.assertEqual(await maintenance.cleanup(apply=True), {"movements": 501})
        finally:
            event.remove(self.engine.sync_engine, "commit", committed)
        self.assertEqual(len(commits), 2)
        async with self.sessions() as db:
            self.assertEqual(set((await db.scalars(select(Movement.id).where(Movement.id.like("ret-%")))).all()),
                {"ret-alert", "ret-review", "ret-recent"})


if __name__ == "__main__":
    unittest.main()
