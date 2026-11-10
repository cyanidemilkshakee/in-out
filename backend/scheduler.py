"""Bootstrap durable Temporal schedules exactly once per environment."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from temporal_worker import TASK_QUEUE, get_temporal_client
from workflows.alert_rule_cron import AlertRuleCronWorkflow
from workflows.checkpoint_heartbeat_cron import CheckpointHeartbeatCronWorkflow

logger = logging.getLogger(__name__)

LEGACY_ALERT_WORKFLOW_ID = "alert-rule-cron"
ALERT_WORKFLOW_ID = "alert-rule-cron-hourly"


async def bootstrap_schedules() -> None:
    client = await get_temporal_client()
    # Cron settings are persisted with the workflow execution. Retire the old
    # five-minute workflow so deployments actually switch to the hourly cadence.
    try:
        await client.get_workflow_handle(LEGACY_ALERT_WORKFLOW_ID).terminate(
            "Replacing the five-minute alert evaluation schedule with hourly evaluation"
        )
        logger.info("%s retired", LEGACY_ALERT_WORKFLOW_ID)
    except RPCError as error:
        if error.status != RPCStatusCode.NOT_FOUND:
            raise
        logger.info("%s is not running", LEGACY_ALERT_WORKFLOW_ID)

    schedules = (
        (AlertRuleCronWorkflow.run, ALERT_WORKFLOW_ID, "0 * * * *"),
        (CheckpointHeartbeatCronWorkflow.run, "checkpoint-heartbeat-cron", "* * * * *"),
    )
    for workflow_run, workflow_id, cron in schedules:
        try:
            await client.start_workflow(workflow_run, id=workflow_id, task_queue=TASK_QUEUE,
                cron_schedule=cron, rpc_timeout=timedelta(seconds=5))
            logger.info("%s scheduled", workflow_id)
        except WorkflowAlreadyStartedError:
            logger.info("%s is already scheduled", workflow_id)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(bootstrap_schedules())


if __name__ == "__main__":
    main()
