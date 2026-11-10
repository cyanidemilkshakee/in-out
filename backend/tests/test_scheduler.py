"""Temporal schedule setup retains stable identity and has a finite RPC deadline."""
from datetime import timedelta
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.exceptions import WorkflowAlreadyStartedError

import scheduler


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_has_rpc_deadline_and_uses_hourly_alert_schedule(self):
        start = AsyncMock()
        terminate = AsyncMock()
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start,
                    get_workflow_handle=lambda workflow_id: SimpleNamespace(terminate=terminate)))):
            await scheduler.bootstrap_schedules()
        terminate.assert_awaited_once_with(
            "Replacing the five-minute alert evaluation schedule with hourly evaluation")
        self.assertEqual(start.await_args_list[0].args, (scheduler.AlertRuleCronWorkflow.run,))
        self.assertEqual(start.await_args_list[1].args, (scheduler.CheckpointHeartbeatCronWorkflow.run,))
        self.assertEqual(start.await_args_list[0].kwargs, {"id": "alert-rule-cron-hourly",
            "task_queue": scheduler.TASK_QUEUE, "cron_schedule": "0 * * * *",
            "rpc_timeout": timedelta(seconds=5)})
        self.assertEqual(start.await_args_list[1].kwargs, {"id": "checkpoint-heartbeat-cron",
            "task_queue": scheduler.TASK_QUEUE, "cron_schedule": "* * * * *",
            "rpc_timeout": timedelta(seconds=5)})

    async def test_repeated_bootstrap_keeps_existing_schedule(self):
        start = AsyncMock(side_effect=[
            WorkflowAlreadyStartedError("alert-rule-cron-hourly", "AlertRuleCronWorkflow"),
            WorkflowAlreadyStartedError("checkpoint-heartbeat-cron", "CheckpointHeartbeatCronWorkflow"),
        ])
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start,
                    get_workflow_handle=lambda workflow_id: SimpleNamespace(terminate=AsyncMock())))):
            await scheduler.bootstrap_schedules()
        self.assertEqual(start.await_count, 2)

    async def test_rpc_timeout_is_reported_so_setup_can_retry(self):
        start = AsyncMock(side_effect=[None, TimeoutError("Temporal RPC deadline elapsed")])
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start,
                    get_workflow_handle=lambda workflow_id: SimpleNamespace(terminate=AsyncMock())))):
            with self.assertRaises(TimeoutError):
                await scheduler.bootstrap_schedules()
        self.assertEqual(start.await_count, 2)


if __name__ == "__main__":
    unittest.main()
