"""
AlertRuleCronWorkflow — Evaluates scheduled alert rules once per hour.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from workflows.activities import run_alert_rule_evaluation


@workflow.defn
class AlertRuleCronWorkflow:
    @workflow.run
    async def run(self) -> int:
        """Called by Temporal once per hour via cron_schedule."""
        return await workflow.execute_activity(
            run_alert_rule_evaluation,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
