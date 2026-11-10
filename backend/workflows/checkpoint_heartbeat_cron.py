"""Monitor checkpoint heartbeat state independently every minute."""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from workflows.activities import run_checkpoint_heartbeat_evaluation


@workflow.defn
class CheckpointHeartbeatCronWorkflow:
    @workflow.run
    async def run(self) -> int:
        return await workflow.execute_activity(
            run_checkpoint_heartbeat_evaluation,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
