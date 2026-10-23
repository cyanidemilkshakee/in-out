"""Approval outages recover durably without renewing the original deadline."""
import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.exceptions import ActivityError, ApplicationError, RetryState
from workflows.activities import auto_deny_override, auto_deny_visitor
from workflows.approval_recovery import RECOVERY_PATCH, RECOVERY_RETRY, execute_approval_activity
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow


def exhausted_error(*, retry_state=RetryState.MAXIMUM_ATTEMPTS_REACHED, error_type="OperationalError", non_retryable=False):
    error = ActivityError("Activity failed", scheduled_event_id=1, started_event_id=2,
        identity="isolated-worker", activity_type="approval", activity_id="1", retry_state=retry_state)
    error.__cause__ = ApplicationError("Dependency unavailable", type=error_type, non_retryable=non_retryable)
    return error


class ApprovalRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_workflow_generations_recover_after_original_attempts_exhaust(self):
        now = datetime(2026, 10, 19, tzinfo=timezone.utc)
        for workflow_class, expiry in ((PermissionOverrideWorkflow, auto_deny_override),
                                       (VisitorApprovalWorkflow, auto_deny_visitor)):
            for authoritative in (False, True):
                with self.subTest(workflow=workflow_class.__name__, authoritative=authoritative):
                    version = lambda name: name == RECOVERY_PATCH or authoritative
                    instance = workflow_class()
                    with patch("temporalio.workflow.patched", side_effect=version), \
                         patch("temporalio.workflow.now", return_value=now), \
                         patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=asyncio.TimeoutError)), \
                         patch("temporalio.workflow.sleep", new=AsyncMock()) as sleep, \
                         patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=[
                             exhausted_error(), {"status": "denied"}])) as execute:
                        self.assertEqual(await instance.run("request", (now - timedelta(seconds=1)).isoformat()), "auto_denied")
                    original, recovered = execute.await_args_list
                    self.assertEqual(original.args, (expiry, "request"))
                    self.assertEqual(recovered.args, original.args)
                    self.assertEqual(original.kwargs["retry_policy"].maximum_attempts, 3)
                    self.assertEqual(recovered.kwargs["retry_policy"], RECOVERY_RETRY)
                    self.assertEqual(recovered.kwargs["start_to_close_timeout"], timedelta(seconds=30))
                    self.assertEqual(RECOVERY_RETRY.maximum_attempts, 0)
                    self.assertEqual(RECOVERY_RETRY.backoff_coefficient, 2)
                    self.assertEqual(RECOVERY_RETRY.maximum_interval, timedelta(minutes=5))
                    sleep.assert_awaited_once_with(timedelta(seconds=30))

    async def test_unpatched_failure_histories_keep_the_original_terminal_failure(self):
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            for authoritative in (False, True):
                with self.subTest(workflow=workflow_class.__name__, authoritative=authoritative):
                    failure = exhausted_error()
                    version = lambda name: authoritative if name != RECOVERY_PATCH else False
                    with patch("temporalio.workflow.patched", side_effect=version), \
                         patch("temporalio.workflow.now", return_value=datetime(2026, 10, 19, tzinfo=timezone.utc)), \
                         patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=asyncio.TimeoutError)), \
                         patch("temporalio.workflow.sleep", new=AsyncMock()) as sleep, \
                         patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=failure)) as execute:
                        with self.assertRaises(ActivityError) as caught:
                            await workflow_class().run("request", "2026-10-18T00:00:00+00:00")
                    self.assertIs(caught.exception, failure)
                    execute.assert_awaited_once()
                    sleep.assert_not_awaited()

    async def test_cancellation_and_permanent_errors_do_not_enter_dependency_recovery(self):
        for failure in (exhausted_error(retry_state=RetryState.CANCEL_REQUESTED),
                        exhausted_error(retry_state=RetryState.NON_RETRYABLE_FAILURE),
                        exhausted_error(error_type="HTTPException"),
                        exhausted_error(non_retryable=True)):
            with self.subTest(retry_state=failure.retry_state, cause=failure.cause.type):
                with patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=failure)), \
                     patch("temporalio.workflow.patched") as patched, \
                     patch("temporalio.workflow.sleep", new=AsyncMock()) as sleep:
                    with self.assertRaises(ActivityError):
                        await execute_approval_activity(auto_deny_visitor, "request")
                patched.assert_not_called()
                sleep.assert_not_awaited()

    async def test_recovery_uses_database_decision_instead_of_overwriting_an_approval(self):
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            with self.subTest(workflow=workflow_class.__name__):
                with patch("temporalio.workflow.patched", return_value=True), \
                     patch("temporalio.workflow.now", return_value=datetime(2026, 10, 19, tzinfo=timezone.utc)), \
                     patch("temporalio.workflow.sleep", new=AsyncMock()), \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=[
                         exhausted_error(), {"status": "approved"}])):
                    self.assertEqual(await workflow_class().run("request", "2026-10-18T00:00:00+00:00"), "approved")

    async def test_signal_observer_recovery_does_not_restart_an_elapsed_approval_window(self):
        for workflow_class, minutes, expiry in ((PermissionOverrideWorkflow, 10, auto_deny_override),
                                                (VisitorApprovalWorkflow, 30, auto_deny_visitor)):
            with self.subTest(workflow=workflow_class.__name__):
                current = datetime(2026, 10, 19, tzinfo=timezone.utc)
                deadline = current + timedelta(minutes=minutes)
                instance = workflow_class()
                if workflow_class is PermissionOverrideWorkflow:
                    await instance.admin_decision("approved", "forged-admin", "Notification only")
                else:
                    await instance.admin_decision("approved", "Notification only")
                attempts = 0

                async def execute(*args, **kwargs):
                    nonlocal attempts, current
                    attempts += 1
                    if attempts == 1:
                        raise exhausted_error()
                    if attempts == 2:
                        current = deadline + timedelta(minutes=1)
                        return {"status": "pending"}
                    return {"status": "denied"}

                with patch("temporalio.workflow.patched", return_value=True), \
                     patch("temporalio.workflow.now", side_effect=lambda: current), \
                     patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, \
                     patch("temporalio.workflow.sleep", new=AsyncMock()), \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=execute)) as activity:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                wait.assert_awaited_once()
                self.assertEqual(wait.await_args.kwargs["timeout"], timedelta(minutes=minutes))
                self.assertIs(activity.await_args_list[-1].args[0], expiry)


if __name__ == "__main__":
    unittest.main()
