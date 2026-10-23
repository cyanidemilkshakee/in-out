"""Approval signals and timeouts keep their decisions after activity cleanup."""
import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import get_type_hints
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow
from workflows.activities import approve_override, deny_override, auto_deny_override, approve_visitor, deny_visitor, auto_deny_visitor
from temporalio.converter import DataConverter


class ApprovalWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = patch("temporalio.workflow.now", return_value=datetime(2026, 10, 10, tzinfo=timezone.utc))
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.version = patch("temporalio.workflow.patched", return_value=True)
        self.version.start()
        self.addCleanup(self.version.stop)

    async def test_manual_and_visitor_signals_approve_the_original_request(self):
        for workflow_class, activity, timeout in ((PermissionOverrideWorkflow, approve_override, 10), (VisitorApprovalWorkflow, approve_visitor, 30)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                if workflow_class is PermissionOverrideWorkflow:
                    await instance.admin_decision("approved", "admin", "Checked")
                    expected_args = ["request", "admin", "Checked"]
                else:
                    await instance.admin_decision("approved", "Checked")
                    expected_args = ["request", "Checked"]
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "approved"})) as execute:
                    self.assertEqual(await instance.run("request"), "approved")
                self.assertEqual(instance.current_status(), "approved")
                self.assertEqual(wait.await_args.kwargs["timeout"], timedelta(minutes=timeout))
                self.assertFalse(wait.await_args.args[0]())
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)
                self.assertEqual(execute.await_args.kwargs["args"], expected_args)

    async def test_denial_signals_keep_decision_reasons(self):
        for workflow_class, activity in ((PermissionOverrideWorkflow, deny_override), (VisitorApprovalWorkflow, deny_visitor)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                if workflow_class is PermissionOverrideWorkflow:
                    await instance.admin_decision("denied", "admin", "ID mismatch")
                else:
                    await instance.admin_decision("denied", "ID mismatch")
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()), patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "denied"})) as execute:
                    self.assertEqual(await instance.run("request"), "denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)
                self.assertEqual(execute.await_args.kwargs["args"], ["request", "ID mismatch"])

    async def test_unanswered_requests_still_auto_deny(self):
        for workflow_class, activity in ((PermissionOverrideWorkflow, auto_deny_override), (VisitorApprovalWorkflow, auto_deny_visitor)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                with patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=asyncio.TimeoutError)), patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "denied"})) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                self.assertEqual(instance.current_status(), "auto_denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)
                self.assertEqual(execute.await_args.args[1], "request")

    async def test_delayed_outbox_start_uses_original_database_deadline(self):
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                elapsed = datetime(2026, 10, 9, tzinfo=timezone.utc).isoformat()
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "denied"})):
                    self.assertEqual(await instance.run("request", elapsed), "auto_denied")
                wait.assert_not_awaited()

    async def test_only_the_first_admin_signal_is_applied(self):
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                if workflow_class is PermissionOverrideWorkflow:
                    await instance.admin_decision("approved", "admin", "Checked")
                    await instance.admin_decision("denied", "other-admin", "Late denial")
                else:
                    await instance.admin_decision("approved", "Checked")
                    await instance.admin_decision("denied", "Late denial")
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()), patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "approved"})):
                    self.assertEqual(await instance.run("request"), "approved")

    async def test_uncommitted_signal_does_not_complete_or_disable_timeout(self):
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                if workflow_class is PermissionOverrideWorkflow:
                    await instance.admin_decision("approved", "forged-admin", "Forged RPC signal")
                else:
                    await instance.admin_decision("approved", "Forged RPC signal")
                with patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=[None, asyncio.TimeoutError])), \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=[{"status": "pending"}, {"status": "denied"}])) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                self.assertEqual(execute.await_count, 2)
                self.assertIs(execute.await_args_list[1].args[0],
                    auto_deny_override if workflow_class is PermissionOverrideWorkflow else auto_deny_visitor)

    async def test_continuous_ready_notifications_cannot_suppress_deadline(self):
        for workflow_class, minutes in ((PermissionOverrideWorkflow, 10), (VisitorApprovalWorkflow, 30)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                current = datetime(2026, 10, 10, tzinfo=timezone.utc)
                deadline = current + timedelta(minutes=minutes)
                async def notify():
                    if workflow_class is PermissionOverrideWorkflow:
                        await instance.admin_decision("approved", "forged-admin", "Ready notification")
                    else:
                        await instance.admin_decision("approved", "Ready notification")
                await notify()
                async def activity_result(*args, **kwargs):
                    nonlocal current
                    if args[0] in (auto_deny_override, auto_deny_visitor):
                        return {"status": "denied"}
                    current = deadline
                    await notify()  # Keep the predicate ready at the deadline.
                    return {"status": "pending"}
                with patch("temporalio.workflow.now", side_effect=lambda: current), \
                     patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(side_effect=activity_result)) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                wait.assert_awaited_once()
                self.assertEqual(execute.await_count, 2)
                self.assertIs(execute.await_args_list[1].args[0],
                    auto_deny_override if workflow_class is PermissionOverrideWorkflow else auto_deny_visitor)

    async def test_notification_arriving_at_deadline_runs_timeout_activity(self):
        for workflow_class, minutes in ((PermissionOverrideWorkflow, 10), (VisitorApprovalWorkflow, 30)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                current = datetime(2026, 10, 10, tzinfo=timezone.utc)
                deadline = current + timedelta(minutes=minutes)
                async def notification_at_deadline(*args, **kwargs):
                    nonlocal current
                    current = deadline
                    if workflow_class is PermissionOverrideWorkflow:
                        await instance.admin_decision("approved", "forged-admin", "Deadline notification")
                    else:
                        await instance.admin_decision("approved", "Deadline notification")
                with patch("temporalio.workflow.now", side_effect=lambda: current), \
                     patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=notification_at_deadline)), \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "denied"})) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0],
                    auto_deny_override if workflow_class is PermissionOverrideWorkflow else auto_deny_visitor)

    async def test_legacy_history_sequence_retains_commands_without_treating_none_as_approval(self):
        for workflow_class, activity in ((PermissionOverrideWorkflow, approve_override), (VisitorApprovalWorkflow, approve_visitor)):
            for result in (None, {"status": "pending"}, {"status": "approved"}):
                with self.subTest(workflow=workflow_class.__name__, persisted=result):
                    instance = workflow_class()
                    if workflow_class is PermissionOverrideWorkflow:
                        await instance.admin_decision("approved", "forged-admin", "Notification")
                        args = ["request", "forged-admin", "Notification"]
                    else:
                        await instance.admin_decision("approved", "Notification")
                        args = ["request", "Notification"]
                    with patch("temporalio.workflow.patched", return_value=False), \
                         patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, \
                         patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value=result)) as execute:
                        self.assertEqual(await instance.run("request"), "approved" if result == {"status": "approved"} else "pending")
                    wait.assert_awaited_once()
                    execute.assert_awaited_once()
                    self.assertIs(execute.await_args.args[0], activity)
                    self.assertEqual(execute.await_args.kwargs["args"], args)

    async def test_legacy_timeout_sequence_observes_persisted_status(self):
        for workflow_class, activity in ((PermissionOverrideWorkflow, auto_deny_override), (VisitorApprovalWorkflow, auto_deny_visitor)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                with patch("temporalio.workflow.patched", return_value=False), \
                     patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=asyncio.TimeoutError)), \
                     patch("temporalio.workflow.execute_activity", new=AsyncMock(return_value={"status": "denied"})) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)

    async def test_legacy_null_activity_payloads_still_decode_with_current_annotations(self):
        converter = DataConverter.default
        payloads = await converter.encode([None])
        for activity in (auto_deny_override, approve_visitor, deny_visitor, auto_deny_visitor):
            with self.subTest(activity=activity.__name__):
                decoded = await converter.decode(payloads, [get_type_hints(activity)["return"]])
                self.assertEqual(decoded, [None])

    async def test_both_workflows_prepare_in_temporal_sandbox(self):
        from temporalio import workflow
        from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner
        for workflow_class in (PermissionOverrideWorkflow, VisitorApprovalWorkflow):
            with self.subTest(workflow=workflow_class.__name__):
                SandboxedWorkflowRunner().prepare_workflow(workflow._Definition.must_from_class(workflow_class))
