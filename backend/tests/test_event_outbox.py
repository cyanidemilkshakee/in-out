"""Atomic delivery, crash recovery, and ordered snapshot catch-up on PostgreSQL."""
import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete, select, text, update
import event_outbox as outbox
from models import EventOutbox, EventStreamState, PermissionRequestModel, Person
import test_database as fixture


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Dedicated PostgreSQL required")
class EventOutboxTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def queue(self, payload=None):
        async with self.sessions() as db:
            revision = await outbox.enqueue_presence(db, payload or {"type": "data_changed"})
            await db.commit()
            return revision

    async def test_business_change_and_revision_roll_back_together(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "name": "Rolled back"}
            await outbox.enqueue_changed(db)
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(Person, "p1")).data["name"], "Alice")
            self.assertEqual(await outbox.read_event_revision(db), 0)
            self.assertEqual((await db.scalars(select(EventOutbox))).all(), [])
        self.assertEqual(await self.queue(), 1)

    async def test_revision_order_follows_commit_order_and_not_sequence_allocation(self):
        waiting, completed = asyncio.Event(), asyncio.Event()
        async with self.sessions() as first:
            self.assertEqual(await outbox.enqueue_changed(first), 1)

            async def second():
                waiting.set()
                revision = await self.queue()
                completed.set()
                return revision

            task = asyncio.create_task(second())
            await waiting.wait()
            await asyncio.sleep(0.04)
            self.assertFalse(completed.is_set())
            async with self.sessions() as observer:
                self.assertEqual(await outbox.read_event_revision(observer), 0)
            await first.commit()
            self.assertEqual(await asyncio.wait_for(task, 3), 2)
        async with self.sessions() as db:
            self.assertEqual([revision for revision, _ in await outbox.replay_events(db, 0, 2)], [1, 2])

    async def test_replay_includes_committed_unpublished_rows_and_workflow_gaps(self):
        one = await self.queue()
        async with self.sessions() as db:
            await outbox.enqueue_workflow_start(db, "synthetic-request")
            await db.commit()
        three = await self.queue()
        async with self.sessions() as db:
            replay = await outbox.replay_events(db, 0, three)
            self.assertEqual([row[0] for row in replay], [one, three])
            self.assertEqual(replay[-1][1]["previousRevision"], one)
            self.assertEqual(await outbox.replay_events(db, three, three), [])
            self.assertIsNone(await outbox.replay_events(db, three + 1, three))
            await db.execute(delete(EventOutbox).where(EventOutbox.id == one))
            await db.commit()
            self.assertIsNone(await outbox.replay_events(db, 0, three))

    async def test_snapshot_cursor_and_business_reads_share_one_mvcc_snapshot(self):
        async with self.sessions() as reader:
            self.assertEqual(await outbox.read_event_revision(reader), 0)
            async with self.sessions() as writer:
                person = await writer.get(Person, "p1")
                person.data = {**person.data, "name": "After snapshot"}
                await outbox.enqueue_changed(writer)
                await writer.commit()
            self.assertEqual((await reader.get(Person, "p1")).data["name"], "Alice")
        async with self.sessions() as db:
            self.assertEqual(await outbox.read_event_revision(db), 1)
            self.assertEqual((await db.get(Person, "p1")).data["name"], "After snapshot")

    async def test_failure_retries_persistently_and_delivery_is_acknowledged(self):
        identifier = await self.queue()
        deliver = AsyncMock(side_effect=RuntimeError("synthetic outage"))
        self.assertTrue(await outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        async with self.sessions() as db:
            row = await db.get(EventOutbox, identifier)
            self.assertIsNone(row.delivered_at)
            self.assertIsNone(row.lease_owner)
            self.assertEqual(row.attempts, 1)
            self.assertGreater(row.available_at, datetime.now(timezone.utc))
            row.available_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await db.commit()
        deliver.side_effect = None
        await outbox.dispatch_one(sessions=self.sessions, deliver=deliver)
        async with self.sessions() as db:
            row = await db.get(EventOutbox, identifier)
            self.assertIsNotNone(row.delivered_at)
            self.assertEqual(row.attempts, 2)
        self.assertFalse(await outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        self.assertEqual(deliver.await_count, 2)

    async def test_concurrent_dispatchers_claim_distinct_rows_and_expired_leases_recover(self):
        one, two = await self.queue(), await self.queue()
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []

        async def deliver(_kind, payload):
            seen.append(payload["revision"])
            if len(seen) == 1:
                entered.set()
                await release.wait()

        task = asyncio.create_task(outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        await entered.wait()
        self.assertTrue(await outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        release.set()
        await task
        self.assertEqual(sorted(seen), [one, two])
        three = await self.queue()
        async with self.sessions() as db:
            row = await db.get(EventOutbox, three)
            row.lease_owner = "dead-worker"
            row.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1)
            await db.commit()
        self.assertTrue(await outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        self.assertEqual(seen[-1], three)

    async def test_cancelled_delivery_is_recovered_after_lease_expires(self):
        identifier = await self.queue()
        entered = asyncio.Event()

        async def stalled(_kind, _payload):
            entered.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(outbox.dispatch_one(sessions=self.sessions, deliver=stalled))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        async with self.sessions() as db:
            row = await db.get(EventOutbox, identifier)
            self.assertIsNotNone(row.lease_owner)
            self.assertIsNone(row.delivered_at)
            row.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1)
            await db.commit()
        deliver = AsyncMock()
        self.assertTrue(await outbox.dispatch_one(sessions=self.sessions, deliver=deliver))
        deliver.assert_awaited_once()

    async def test_payload_and_replay_bounds_fail_explicitly(self):
        async with self.sessions() as db:
            for kind, payload in (("arbitrary", {}), ("presence", {"value": float("nan")}),
                                  ("presence", {"value": "x" * outbox.MAX_EVENT_BYTES})):
                with self.assertRaises(ValueError):
                    await outbox.enqueue(db, kind, payload)
            await db.rollback()
        one, two = await self.queue(), await self.queue()
        async with self.sessions() as db:
            with patch.object(outbox, "MAX_REPLAY_EVENTS", 1):
                self.assertIsNone(await outbox.replay_events(db, 0, two))
                self.assertEqual(len(await outbox.replay_events(db, one, two)), 1)
            with patch.object(outbox, "MAX_REPLAY_BYTES", 1):
                self.assertIsNone(await outbox.replay_events(db, 0, two))

    async def test_temporal_start_retries_idempotently_with_original_deadline(self):
        from temporalio.exceptions import WorkflowAlreadyStartedError
        from types import SimpleNamespace
        created = datetime.now(timezone.utc) - timedelta(hours=1)
        async with self.sessions() as db:
            db.add(PermissionRequestModel(id="delayed", created_at=created, data={"type": "manual_override", "status": "pending"}))
            await db.commit()
        client = SimpleNamespace(start_workflow=AsyncMock(side_effect=WorkflowAlreadyStartedError("override-delayed", "PermissionOverrideWorkflow")))
        with patch.object(outbox, "AsyncSessionLocal", self.sessions), \
             patch("temporal_worker.get_temporal_client", new=AsyncMock(return_value=client)):
            await outbox._deliver("workflow_start", {"workflow": "PermissionOverrideWorkflow", "workflowId": "override-delayed", "args": ["delayed"]})
        self.assertEqual(client.start_workflow.await_args.kwargs["args"], ["delayed", (created + timedelta(minutes=10)).isoformat()])
        from temporalio.common import WorkflowIDReusePolicy
        self.assertEqual(client.start_workflow.await_args.kwargs["id_reuse_policy"], WorkflowIDReusePolicy.REJECT_DUPLICATE)

    async def test_signal_waits_for_pending_start_but_completed_legacy_signal_can_finish(self):
        from temporalio.service import RPCError, RPCStatusCode
        from types import SimpleNamespace
        signal = AsyncMock(side_effect=RPCError("not found", RPCStatusCode.NOT_FOUND, b""))
        client = SimpleNamespace(get_workflow_handle=lambda _identifier: SimpleNamespace(signal=signal))
        async with self.sessions() as db:
            await outbox.enqueue_workflow_start(db, "delayed")
            await db.commit()
        with patch.object(outbox, "AsyncSessionLocal", self.sessions), \
             patch("temporal_worker.get_temporal_client", new=AsyncMock(return_value=client)):
            with self.assertRaises(RPCError):
                await outbox._deliver("workflow_signal", {"workflowId": "override-delayed", "args": ["denied"]})
            async with self.sessions() as db:
                await db.execute(update(EventOutbox).values(delivered_at=datetime.now(timezone.utc)))
                await db.commit()
            await outbox._deliver("workflow_signal", {"workflowId": "override-delayed", "args": ["denied"]})

    async def test_committed_event_is_delivered_through_real_redis(self):
        from redis_client import subscribe_presence
        ready = asyncio.Event()
        subscription = subscribe_presence(ready)
        pending = asyncio.create_task(anext(subscription))
        try:
            await asyncio.wait_for(ready.wait(), 3)
            identifier = await self.queue()
            self.assertTrue(await outbox.dispatch_one(sessions=self.sessions))
            import json
            payload = json.loads(await asyncio.wait_for(pending, 3))
            self.assertEqual((payload["type"], payload["revision"]), ("data_changed", identifier))
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await subscription.aclose()

    async def test_stale_worker_cannot_undo_new_owners_delivery_acknowledgement(self):
        identifier = await self.queue()
        entered, release = asyncio.Event(), asyncio.Event()

        async def original_delivery(_kind, _payload):
            entered.set()
            await release.wait()
            raise RuntimeError("Old worker failed after losing its lease")

        original = asyncio.create_task(outbox.dispatch_one(sessions=self.sessions, deliver=original_delivery))
        await entered.wait()
        async with self.sessions() as db:
            row = await db.get(EventOutbox, identifier)
            row.lease_until = datetime.now(timezone.utc) - timedelta(seconds=1)
            await db.commit()
        await outbox.dispatch_one(sessions=self.sessions, deliver=AsyncMock())
        release.set()
        await original
        async with self.sessions() as db:
            row = await db.get(EventOutbox, identifier)
            self.assertIsNotNone(row.delivered_at)
            self.assertEqual(row.attempts, 2)
            self.assertIsNone(row.lease_owner)

    async def test_retention_removes_only_old_delivered_technical_records(self):
        delivered, pending = await self.queue(), await self.queue()
        old = datetime.now(timezone.utc) - timedelta(days=8)
        async with self.sessions() as db:
            await db.execute(update(EventOutbox).values(created_at=old))
            await db.execute(update(EventOutbox).where(EventOutbox.id == delivered).values(delivered_at=old))
            await db.commit()
        await outbox.prune_delivered(sessions=self.sessions)
        async with self.sessions() as db:
            self.assertIsNone(await db.get(EventOutbox, delivered))
            self.assertIsNotNone(await db.get(EventOutbox, pending))
            self.assertIsNone(await outbox.replay_events(db, 0, pending))

    async def test_migration_bridges_pending_requests_with_stable_workflow_ids(self):
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        import importlib.util
        spec = importlib.util.spec_from_file_location("test_outbox_migration", Path(__file__).resolve().parents[1] / "alembic/versions/a5b6c7d8e9_event_outbox.py")
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        async with self.sessions() as db:
            db.add_all([PermissionRequestModel(id=identifier, created_at=datetime.now(timezone.utc), data={"type": kind, "status": status})
                        for identifier, kind, status in (("visitor-pending", "visitor", "pending"),
                            ("manual-pending", "manual_override", "pending"), ("done", "visitor", "approved"))])
            await db.commit()
        async with self.engine.begin() as conn:
            def replace(connection):
                with Operations.context(MigrationContext.configure(connection)):
                    migration.downgrade()
                    migration.upgrade()
            await conn.run_sync(replace)
        async with self.sessions() as db:
            rows = (await db.scalars(select(EventOutbox).order_by(EventOutbox.id))).all()
            self.assertEqual({row.payload["workflowId"] for row in rows}, {"visitor-visitor-pending", "override-manual-pending"})
            self.assertEqual(await outbox.read_event_revision(db), 0)
        self.assertEqual(await self.queue(), 3)

