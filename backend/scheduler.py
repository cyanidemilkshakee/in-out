"""Bootstrap durable Temporal schedules exactly once per environment."""
from __future__ import annotations

import asyncio
import logging

from temporalio.exceptions import WorkflowAlreadyStartedError

from temporal_worker import TASK_QUEUE, get_temporal_client
from workflows.alert_rule_cron import AlertRuleCronWorkflow

logger = logging.getLogger(__name__)


async def bootstrap_schedules() -> None:
    client = await get_temporal_client()
    try:
        await client.start_workflow(
            AlertRuleCronWorkflow.run,
            id="alert-rule-cron",
            task_queue=TASK_QUEUE,
            cron_schedule="*/5 * * * *",
        )
        logger.info("AlertRuleCronWorkflow scheduled")
    except WorkflowAlreadyStartedError:
        # The cron workflow is durable in Temporal. Re-running this bootstrap
        # after a deployment must not create a duplicate scheduler.
        logger.info("AlertRuleCronWorkflow is already scheduled")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(bootstrap_schedules())


if __name__ == "__main__":
    main()
