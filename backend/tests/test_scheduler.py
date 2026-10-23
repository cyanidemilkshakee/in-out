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
    async def test_start_has_rpc_deadline_and_preserves_durable_schedule_identity(self):
        start = AsyncMock()
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start))):
            await scheduler.bootstrap_schedules()
        start.assert_awaited_once_with(scheduler.AlertRuleCronWorkflow.run,
            id="alert-rule-cron", task_queue=scheduler.TASK_QUEUE,
            cron_schedule="*/5 * * * *", rpc_timeout=timedelta(seconds=5))

    async def test_repeated_bootstrap_keeps_existing_schedule(self):
        start = AsyncMock(side_effect=WorkflowAlreadyStartedError("alert-rule-cron", "AlertRuleCronWorkflow"))
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start))):
            await scheduler.bootstrap_schedules()
        start.assert_awaited_once()

    async def test_rpc_timeout_is_reported_so_setup_can_retry(self):
        start = AsyncMock(side_effect=TimeoutError("Temporal RPC deadline elapsed"))
        with patch.object(scheduler, "get_temporal_client", new=AsyncMock(
                return_value=SimpleNamespace(start_workflow=start))):
            with self.assertRaises(TimeoutError):
                await scheduler.bootstrap_schedules()
        start.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
