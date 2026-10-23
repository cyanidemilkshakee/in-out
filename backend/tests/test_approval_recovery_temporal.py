"""Real history/restart checks against the explicit isolated Temporal fixture.

Set TEST_TEMPORAL_HOST only for the disposable fixture; no server is downloaded
or started by these tests. The ledger substitutes unavailable/recovered database
activities while Temporal itself owns attempts, timers, history and replay.
"""
import asyncio
import logging
import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio import activity, workflow
from temporalio.client import Client, WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
from workflows.approval_recovery import RECOVERY_PATCH
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow

TEST_HOST = os.getenv("TEST_TEMPORAL_HOST")
OLD_PATCH = "database-authoritative-approval-signals-v1"
ORIGINAL_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))


async def prior_run(instance, request_id, deadline_at, *, visitor):
    """Frozen pre-recovery command paths used to produce compatibility histories."""
    authoritative = not request_id.startswith("legacy-")
    if authoritative:
        workflow.patched(OLD_PATCH)
        deadline = datetime.fromisoformat(deadline_at)
        timed_out = workflow.now() >= deadline
    else:
        timed_out = False
    if not timed_out:
        try:
            await workflow.wait_condition(lambda: instance.decision is not None,
                timeout=timedelta(minutes=30 if visitor else 10))
        except asyncio.TimeoutError:
            timed_out = True
    if timed_out:
        result = await workflow.execute_activity("auto_deny_visitor" if visitor else "auto_deny_override",
            request_id, start_to_close_timeout=timedelta(seconds=30), retry_policy=ORIGINAL_RETRY)
    else:
        decision, admin_id, reason = instance.decision
        approved = decision == "approved"
        name = ("approve_visitor" if approved else "deny_visitor") if visitor else (
            "approve_override" if approved else "deny_override")
        arguments = [request_id, reason] if visitor or not approved else [request_id, admin_id, reason]
        result = await workflow.execute_activity(name, args=arguments,
            start_to_close_timeout=timedelta(seconds=60 if not visitor and approved else 30),
            retry_policy=ORIGINAL_RETRY)
    status = result.get("status", "pending")
    return "auto_denied" if timed_out and status == "denied" else status


@workflow.defn(name="VisitorApprovalWorkflow")
class PriorVisitorApproval:
    def __init__(self):
        self.decision = None

    @workflow.run
    async def run(self, request_id: str, deadline_at: str | None = None) -> str:
        return await prior_run(self, request_id, deadline_at, visitor=True)

    @workflow.signal
    async def admin_decision(self, decision: str, reason: str = ""):
        self.decision = (decision, "system", reason)


@workflow.defn(name="PermissionOverrideWorkflow")
class PriorPermissionOverride:
    def __init__(self):
        self.decision = None

    @workflow.run
    async def run(self, request_id: str, deadline_at: str | None = None) -> str:
        return await prior_run(self, request_id, deadline_at, visitor=False)

    @workflow.signal
    async def admin_decision(self, decision: str, admin_id: str = "", reason: str = ""):
        self.decision = (decision, admin_id, reason)


class DatabaseLedger:
    def __init__(self):
        self.statuses = {}
        self.failures = {}
        self.attempts = {}
        self.mutations = {}

    async def read(self, request_id, *, expire=False):
        attempts = self.attempts.setdefault(request_id, [])
        attempts.append(activity.info().attempt)
        failure_count = self.failures.get(request_id, 0)
        if failure_count == -1 or len(attempts) <= failure_count:
            raise ApplicationError("Synthetic database outage", type="OperationalError")
        status = self.statuses.get(request_id, "pending")
        if expire and status == "pending":
            self.mutations[request_id] = self.mutations.get(request_id, 0) + 1
            self.statuses[request_id] = status = "denied"
        return {"status": status}

    @activity.defn(name="auto_deny_override")
    async def expire_override(self, request_id: str) -> dict:
        return await self.read(request_id, expire=True)

    @activity.defn(name="auto_deny_visitor")
    async def expire_visitor(self, request_id: str) -> dict:
        return await self.read(request_id, expire=True)

    @activity.defn(name="approve_override")
    async def approve_override(self, request_id: str, admin_id: str, reason: str) -> dict:
        return await self.read(request_id)

    @activity.defn(name="deny_override")
    async def deny_override(self, request_id: str, reason: str) -> dict:
        return await self.read(request_id)

    @activity.defn(name="approve_visitor")
    async def approve_visitor(self, request_id: str, reason: str) -> dict:
        return await self.read(request_id)

    @activity.defn(name="deny_visitor")
    async def deny_visitor(self, request_id: str, reason: str) -> dict:
        return await self.read(request_id)

    def activities(self):
        return [self.expire_override, self.expire_visitor, self.approve_override,
                self.deny_override, self.approve_visitor, self.deny_visitor]


def has_patch(history, patch_id):
    return any(event.HasField("marker_recorded_event_attributes") and
               patch_id.encode() in event.SerializeToString() for event in history.events)


@unittest.skipUnless(TEST_HOST, "Set TEST_TEMPORAL_HOST for the disposable Temporal fixture")
class ApprovalRecoveryTemporalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = await Client.connect(TEST_HOST)
        self.queue = "approval-recovery-" + uuid.uuid4().hex
        self.ledger = DatabaseLedger()
        self.replayer = Replayer(workflows=[VisitorApprovalWorkflow, PermissionOverrideWorkflow])
        logging.getLogger("temporalio.activity").setLevel(logging.CRITICAL)

    async def history_when(self, handle, condition, *, timeout=30):
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            history = await handle.fetch_history()
            if condition(history):
                return history
            if asyncio.get_running_loop().time() >= deadline:
                self.fail("Expected durable workflow history was not recorded before the fixture deadline")
            await asyncio.sleep(0.1)

    async def replay_and_save(self, handle, label):
        history = await handle.fetch_history()
        await self.replayer.replay_workflow(history)
        output = os.getenv("TEMPORAL_HISTORY_OUTPUT_DIR")
        if output:
            path = Path(output)
            path.mkdir(parents=True, exist_ok=True)
            (path / (label + ".json")).write_text(history.to_json(), encoding="utf-8")
        return history

    async def start(self, kind, request_id, *, deadline=None):
        return await self.client.start_workflow(kind, args=[request_id, deadline],
            id=self.queue + "-" + request_id, task_queue=self.queue,
            execution_timeout=timedelta(minutes=5))

    async def test_pre_authority_signal_histories_replay_without_new_markers(self):
        async with Worker(self.client, task_queue=self.queue,
            workflows=[PriorVisitorApproval, PriorPermissionOverride], activities=self.ledger.activities(),
            workflow_runner=UnsandboxedWorkflowRunner()):
            for kind in ("VisitorApprovalWorkflow", "PermissionOverrideWorkflow"):
                request_id = "legacy-" + kind
                self.ledger.statuses[request_id] = "approved"
                handle = await self.start(kind, request_id)
                await self.history_when(handle, lambda history: any(
                    event.HasField("timer_started_event_attributes") for event in history.events))
                signal = ["approved", "Checked"] if kind == "VisitorApprovalWorkflow" else ["approved", "admin", "Checked"]
                await handle.signal("admin_decision", args=signal)
                self.assertEqual(await asyncio.wait_for(handle.result(), 15), "approved")
                history = await self.replay_and_save(handle, "legacy-signal-" + kind)
                self.assertFalse(has_patch(history, OLD_PATCH))
                self.assertFalse(has_patch(history, RECOVERY_PATCH))

    async def test_pre_recovery_success_and_terminal_failure_histories_replay(self):
        deadline = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        async with Worker(self.client, task_queue=self.queue,
            workflows=[PriorVisitorApproval, PriorPermissionOverride], activities=self.ledger.activities(),
            workflow_runner=UnsandboxedWorkflowRunner()):
            handles = []
            for kind in ("VisitorApprovalWorkflow", "PermissionOverrideWorkflow"):
                for fail in (False, True):
                    request_id = f"previous-{kind}-{fail}"
                    self.ledger.failures[request_id] = -1 if fail else 0
                    handles.append((kind, fail, await self.start(kind, request_id, deadline=deadline)))
            for kind, fail, handle in handles:
                if fail:
                    with self.assertRaises(WorkflowFailureError):
                        await asyncio.wait_for(handle.result(), 30)
                else:
                    self.assertEqual(await asyncio.wait_for(handle.result(), 30), "auto_denied")
                history = await self.replay_and_save(handle, f"previous-expiry-{kind}-{fail}")
                self.assertTrue(has_patch(history, OLD_PATCH))
                self.assertFalse(has_patch(history, RECOVERY_PATCH))
                scheduled = [event.activity_task_scheduled_event_attributes for event in history.events
                             if event.HasField("activity_task_scheduled_event_attributes")]
                self.assertEqual(len(scheduled), 1)
                self.assertEqual(scheduled[0].retry_policy.maximum_attempts, 3)

    async def test_outage_recovery_survives_worker_restart_and_preserves_committed_decisions(self):
        deadline = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        handles = []
        workflows = [VisitorApprovalWorkflow, PermissionOverrideWorkflow]
        async with Worker(self.client, task_queue=self.queue, workflows=workflows,
                          activities=self.ledger.activities()):
            for kind in ("VisitorApprovalWorkflow", "PermissionOverrideWorkflow"):
                for status in ("pending", "approved"):
                    request_id = f"recover-{kind}-{status}"
                    self.ledger.failures[request_id] = 4
                    handles.append((request_id, status, await self.start(kind, request_id, deadline=deadline)))
            cancel_id = "recover-cancelled-visitor"
            self.ledger.failures[cancel_id] = -1
            cancelled = await self.start("VisitorApprovalWorkflow", cancel_id, deadline=deadline)
            for request_id, _, handle in handles + [(cancel_id, "cancelled", cancelled)]:
                await self.history_when(handle, lambda history: has_patch(history, RECOVERY_PATCH), timeout=30)
                self.assertEqual(self.ledger.attempts[request_id], [1, 2, 3])
                self.assertEqual(self.ledger.mutations.get(request_id, 0), 0)

        # The worker is stopped while Temporal retains each recovery timer.
        # These updates model authenticated decisions committed during the outage.
        for request_id, status, _ in handles:
            if status == "approved":
                self.ledger.statuses[request_id] = "approved"
        await cancelled.cancel()

        async with Worker(self.client, task_queue=self.queue, workflows=workflows,
                          activities=self.ledger.activities()):
            for request_id, status, handle in handles:
                expected = "approved" if status == "approved" else "auto_denied"
                self.assertEqual(await asyncio.wait_for(handle.result(), 105), expected)
                self.assertEqual(self.ledger.attempts[request_id], [1, 2, 3, 1, 2])
                self.assertEqual(self.ledger.mutations.get(request_id, 0), 0 if status == "approved" else 1)
                history = await self.replay_and_save(handle, request_id)
                scheduled = [event.activity_task_scheduled_event_attributes for event in history.events
                             if event.HasField("activity_task_scheduled_event_attributes")]
                self.assertEqual(len(scheduled), 2)
                self.assertEqual(scheduled[0].retry_policy.maximum_attempts, 3)
                self.assertEqual(scheduled[1].retry_policy.maximum_attempts, 0)
                self.assertEqual(scheduled[1].retry_policy.maximum_interval.ToTimedelta(), timedelta(minutes=5))
                self.assertEqual(scheduled[0].input, scheduled[1].input)
            with self.assertRaises(WorkflowFailureError):
                await asyncio.wait_for(cancelled.result(), 15)
            self.assertEqual(self.ledger.mutations.get(cancel_id, 0), 0)
            await self.replay_and_save(cancelled, cancel_id)


if __name__ == "__main__":
    unittest.main()
