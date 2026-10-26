"""Write paths persist delivery intent before committing, without network waits."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import permissions, terminal
from schemas import BrowserScanPayload, PermissionDecision
import temporal_worker
from workflows.activities import _enqueue_alert_batches
from event_outbox import MAX_EVENT_BYTES


class MutationOutboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_delivery_intent_precedes_commit_and_replay_does_not_duplicate_it(self):
        result = {"allowed": True, "subject_id": "p1", "decision": {"event": {"direction": "entry"}},
            "updatedPeople": [{"id": "p1"}]}
        events = []
        db = Mock(info={}, get=AsyncMock(return_value=SimpleNamespace(data={"mode": "auto"})),
            commit=AsyncMock(side_effect=lambda: events.append("commit")))

        async def enqueue(db_arg, payload):
            self.assertIs(db_arg, db)
            self.assertEqual(payload["state"], "inside")
            self.assertEqual(events, [])
            events.append("enqueue")

        with patch("routers.terminal.require_checkpoint", new=AsyncMock(return_value="cp-main")), \
             patch("routers.terminal.record_scan", new=AsyncMock(return_value=result)), \
             patch("routers.terminal.enqueue_presence", new=AsyncMock(side_effect=enqueue)) as queue, \
             patch("routers.terminal.publish_presence_update", new=AsyncMock(side_effect=AssertionError("No HTTP Redis I/O"))):
            payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
            returned = await terminal.scan(payload, uuid.uuid4(), db, {"sub": "operator"})
            self.assertIs(returned, result)
            self.assertEqual(events, ["enqueue", "commit"])
            db.info["scan_replayed"] = True
            await terminal.scan(payload, uuid.uuid4(), db, {"sub": "operator"})
            self.assertEqual(queue.await_count, 1)

    async def test_enqueue_failure_prevents_scan_commit(self):
        db = Mock(info={}, get=AsyncMock(return_value=SimpleNamespace(data={"mode": "auto"})), commit=AsyncMock())
        result = {"allowed": False, "decision": {"event": {"direction": "entry"}}}
        with patch("routers.terminal.require_checkpoint", new=AsyncMock(return_value="cp-main")), \
             patch("routers.terminal.record_scan", new=AsyncMock(return_value=result)), \
             patch("routers.terminal.enqueue_presence", new=AsyncMock(side_effect=RuntimeError("queue unavailable"))):
            with self.assertRaisesRegex(RuntimeError, "queue unavailable"):
                await terminal.scan(BrowserScanPayload(barcode="p1", checkpointId="cp-main"),
                    uuid.uuid4(), db, {"sub": "operator"})
        db.commit.assert_not_awaited()

    async def test_decision_queues_signal_and_event_then_reports_queued_truthfully(self):
        order = []
        db = Mock(commit=AsyncMock(side_effect=lambda: order.append("commit")))
        result = {"request": {"id": "request", "type": "manual_override", "status": "denied",
            "decidedBy": "system", "decisionReason": "Timed out"}}

        async def signal(db_arg, workflow_id, args):
            self.assertIs(db_arg, db)
            self.assertEqual((workflow_id, args), ("override-request", ["denied", "system", "Timed out"]))
            order.append("signal")

        async def event(db_arg, result_arg):
            self.assertEqual(order, ["signal"])
            self.assertIs(result_arg, result)
            order.append("event")

        with patch("permission_decisions.apply_permission_decision", new=AsyncMock(return_value=result)), \
             patch("routers.permissions._include_entry_restrictions", new=AsyncMock()), \
             patch("routers.permissions.enqueue_workflow_signal", new=AsyncMock(side_effect=signal)), \
             patch("routers.permissions.enqueue_decision", new=AsyncMock(side_effect=event)), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=AssertionError("No HTTP Temporal I/O"))):
            returned = await permissions.decide_permission_request("request",
                PermissionDecision(decision="approved"), db, {"sub": "admin"})
        self.assertEqual(order, ["signal", "event", "commit"])
        self.assertFalse(returned["workflowSignaled"])
        self.assertTrue(returned["workflowQueued"])

    async def test_alert_batches_preserve_all_alerts_with_bounded_delivery_records(self):
        alerts = [{"id": f"alert-{index}", "reason": "x" * (MAX_EVENT_BYTES // 2)} for index in range(4)]
        db = object()
        with patch("workflows.activities.enqueue_presence", new=AsyncMock()) as queue:
            await _enqueue_alert_batches(db, alerts)
        delivered = []
        for arguments in queue.await_args_list:
            self.assertIs(arguments.args[0], db)
            payload = arguments.args[1]
            self.assertLess(len(json.dumps(payload, separators=(",", ":")).encode()), MAX_EVENT_BYTES)
            delivered.extend(payload["alerts"])
        self.assertEqual(delivered, alerts)

    async def test_dispatcher_failure_stops_worker_and_closes_temporal_connection(self):
        finished = asyncio.Event()
        worker = Mock(run=AsyncMock(side_effect=finished.wait), shutdown=AsyncMock(side_effect=finished.set))
        with patch("temporal_worker.get_temporal_client", new=AsyncMock(return_value=object())), \
             patch("temporalio.worker.Worker", return_value=worker), \
             patch("event_outbox.run_dispatcher", new=AsyncMock(side_effect=RuntimeError("isolated dispatcher failure"))), \
             patch("temporal_worker.close_temporal_client", new=AsyncMock()) as close:
            with self.assertRaisesRegex(RuntimeError, "isolated dispatcher failure"):
                await asyncio.wait_for(temporal_worker.run_worker(), 5)
        worker.shutdown.assert_awaited_once()
        close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
