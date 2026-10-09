"""Approval signals and timeouts keep their decisions after activity cleanup."""
import asyncio
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow
from workflows.activities import approve_override, deny_override, auto_deny_override, approve_visitor, deny_visitor, auto_deny_visitor


class ApprovalWorkflowTests(unittest.IsolatedAsyncioTestCase):
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
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()) as wait, patch("temporalio.workflow.execute_activity", new=AsyncMock()) as execute:
                    self.assertEqual(await instance.run("request"), "approved")
                self.assertEqual(instance.current_status(), "approved")
                self.assertEqual(wait.await_args.kwargs["timeout"], timedelta(minutes=timeout))
                self.assertTrue(wait.await_args.args[0]())
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
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()), patch("temporalio.workflow.execute_activity", new=AsyncMock()) as execute:
                    self.assertEqual(await instance.run("request"), "denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)
                self.assertEqual(execute.await_args.kwargs["args"], ["request", "ID mismatch"])

    async def test_unanswered_requests_still_auto_deny(self):
        for workflow_class, activity in ((PermissionOverrideWorkflow, auto_deny_override), (VisitorApprovalWorkflow, auto_deny_visitor)):
            with self.subTest(workflow=workflow_class.__name__):
                instance = workflow_class()
                with patch("temporalio.workflow.wait_condition", new=AsyncMock(side_effect=asyncio.TimeoutError)), patch("temporalio.workflow.execute_activity", new=AsyncMock()) as execute:
                    self.assertEqual(await instance.run("request"), "auto_denied")
                self.assertEqual(instance.current_status(), "auto_denied")
                execute.assert_awaited_once()
                self.assertIs(execute.await_args.args[0], activity)
                self.assertEqual(execute.await_args.args[1], "request")

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
                with patch("temporalio.workflow.wait_condition", new=AsyncMock()), patch("temporalio.workflow.execute_activity", new=AsyncMock()):
                    self.assertEqual(await instance.run("request"), "approved")
