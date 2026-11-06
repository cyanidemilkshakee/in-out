"""Ordered durable lanes and independent worker recovery without live services."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import visitors
from sqlalchemy.sql.selectable import ScalarSelect

import event_outbox as outbox
from models import EventOutbox
import temporal_worker


class DeliveryHeadTests(unittest.TestCase):
    def test_lane_heads_are_chosen_before_availability_and_lease_checks(self):
        query = outbox._next_delivery(None, datetime.now(timezone.utc))
        heads = {id(item): item for item in visitors.iterate(query) if isinstance(item, ScalarSelect)}
        self.assertEqual(len(heads), 2)
        for head in heads.values():
            predicate = str(head.element.whereclause)
            self.assertIn("delivered_at IS NULL", predicate)
            self.assertIn("event_outbox.kind IN", predicate)
            self.assertNotIn("available_at", predicate)
            self.assertNotIn("lease_until", predicate)
            self.assertEqual(head.element._limit_clause.value, 1)
            self.assertEqual(str(head.element._order_by_clauses[0]), "event_outbox.id")
        sql = str(query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn("workflow_start", sql)
        self.assertIn("workflow_signal", sql)
        self.assertIn("event_outbox.available_at <=", sql)
        self.assertIn("event_outbox.lease_until <=", sql)

    def test_explicit_lanes_cannot_claim_other_lane_and_invalid_lane_is_rejected(self):
        for lane, kinds in (("presence", ("presence",)), ("workflow", ("workflow_start", "workflow_signal"))):
            query = outbox._next_delivery(lane, datetime.now(timezone.utc))
            heads = [item for item in visitors.iterate(query) if isinstance(item, ScalarSelect)]
            self.assertEqual(len(heads), 1)
            values = heads[0].element.compile().params.values()
            self.assertIn(list(kinds), values)
        with self.assertRaises(ValueError):
            outbox._next_delivery("unknown", datetime.now(timezone.utc))


class DeliveryLaneTests(unittest.IsolatedAsyncioTestCase):
    async def test_stalled_workflow_delivery_does_not_block_presence_lane_or_shutdown(self):
        entered, presence, workflow_cancelled, stop = (asyncio.Event() for _ in range(4))
        active = {"presence": 0, "workflow": 0}

        async def dispatch(*, lane, **_kwargs):
            active[lane] += 1
            self.assertEqual(active[lane], 1)
            try:
                if lane == "workflow":
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        workflow_cancelled.set()
                await entered.wait()
                presence.set()
                return False
            finally:
                active[lane] -= 1

        with patch.object(outbox, "dispatch_one", new=AsyncMock(side_effect=dispatch)), \
             patch.object(outbox, "prune_delivered", new=AsyncMock()):
            runner = asyncio.create_task(outbox.run_dispatcher(stop))
            try:
                await asyncio.wait_for(presence.wait(), 1)
                self.assertFalse(runner.done())
                self.assertEqual(active["workflow"], 1)
                stop.set()
                await asyncio.wait_for(runner, 1)
                self.assertTrue(workflow_cancelled.is_set())
                self.assertEqual(active, {"presence": 0, "workflow": 0})
            finally:
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)

    async def test_cancelled_delivery_keeps_its_durable_lease_for_recovery(self):
        item = EventOutbox(id=1, kind="presence", payload={"revision": 1}, attempts=0)
        db = Mock(scalar=AsyncMock(return_value=item), commit=AsyncMock(), execute=AsyncMock())
        entered = asyncio.Event()

        @asynccontextmanager
        async def sessions():
            yield db

        async def stalled(_kind, _payload):
            entered.set()
            await asyncio.Event().wait()

        runner = asyncio.create_task(outbox.dispatch_one(lane="presence", sessions=sessions, deliver=stalled))
        await asyncio.wait_for(entered.wait(), 1)
        runner.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await runner
        self.assertIsNotNone(item.lease_owner)
        self.assertGreater(item.lease_until, datetime.now(timezone.utc))
        self.assertIsNone(item.delivered_at)
        self.assertEqual(item.attempts, 1)
        db.commit.assert_awaited_once()
        db.execute.assert_not_awaited()


class IndependentTemporalLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_delivery_starts_while_initial_temporal_connection_is_unavailable(self):
        connecting, delivery_started = asyncio.Event(), asyncio.Event()

        async def connect():
            connecting.set()
            await asyncio.Event().wait()

        async def dispatcher(_stop):
            delivery_started.set()
            await asyncio.Event().wait()

        with patch.object(temporal_worker, "get_temporal_client", new=AsyncMock(side_effect=connect)), \
             patch.object(outbox, "run_dispatcher", new=AsyncMock(side_effect=dispatcher)), \
             patch.object(temporal_worker, "close_temporal_client", new=AsyncMock()) as close:
            runner = asyncio.create_task(temporal_worker.run_worker())
            try:
                await asyncio.wait_for(connecting.wait(), 2)
                await asyncio.wait_for(delivery_started.wait(), 1)
                self.assertFalse(runner.done())
            finally:
                runner.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await runner
            close.assert_awaited_once()

    async def test_temporal_startup_retries_without_restarting_delivery(self):
        started, stop = asyncio.Event(), asyncio.Event()
        attempts = 0

        async def lifecycle(stopping):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ConnectionError("isolated unavailable provider")
            started.set()
            await stopping.wait()

        with patch.object(temporal_worker, "_run_temporal_worker_once", new=AsyncMock(side_effect=lifecycle)), \
             patch.object(temporal_worker, "_WORKER_RETRY_INITIAL_SECONDS", 0.01), \
             patch.object(temporal_worker, "close_temporal_client", new=AsyncMock()) as close:
            runner = asyncio.create_task(temporal_worker._run_temporal_worker(stop))
            try:
                await asyncio.wait_for(started.wait(), 1)
                stop.set()
                await asyncio.wait_for(runner, 1)
            finally:
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)
            self.assertEqual(attempts, 2)
            close.assert_not_awaited()

    async def test_failed_startup_cannot_cancel_deliverys_newer_shared_connection(self):
        old_failed, replacement_started, release, retried, stop = (asyncio.Event() for _ in range(5))
        attempts = 0
        client = object()

        async def connect(_target):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ConnectionError("isolated original connection failure")
            replacement_started.set()
            await release.wait()
            return client

        async def lifecycle(stopping):
            if not old_failed.is_set():
                try:
                    await temporal_worker.get_temporal_client()
                except ConnectionError:
                    old_failed.set()
                    await replacement_started.wait()
                    raise
            retried.set()
            await stopping.wait()

        async def delivery_connection():
            await old_failed.wait()
            return await temporal_worker.get_temporal_client()

        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=connect)), \
             patch.object(temporal_worker, "_run_temporal_worker_once", new=AsyncMock(side_effect=lifecycle)), \
             patch.object(temporal_worker, "_WORKER_RETRY_INITIAL_SECONDS", 0.01):
            worker = asyncio.create_task(temporal_worker._run_temporal_worker(stop))
            delivery = asyncio.create_task(delivery_connection())
            try:
                await asyncio.wait_for(retried.wait(), 1)
                self.assertFalse(delivery.done())
                release.set()
                self.assertIs(await asyncio.wait_for(delivery, 1), client)
                stop.set()
                await asyncio.wait_for(worker, 1)
            finally:
                worker.cancel()
                delivery.cancel()
                await asyncio.gather(worker, delivery, return_exceptions=True)
                await temporal_worker.close_temporal_client()
        self.assertEqual(attempts, 2)


if __name__ == "__main__":
    unittest.main()
