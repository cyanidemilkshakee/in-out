"""
Temporal Worker — connects to the Temporal server and processes workflow/activity tasks.
Started as a background asyncio task in main.py lifespan.
"""
from __future__ import annotations

import logging

from temporalio.client import Client
from temporalio.worker import Worker

from config import settings
from workflows.activities import (
    notify_admins_of_override,
    approve_override,
    deny_override,
    auto_deny_override,
    approve_visitor,
    deny_visitor,
    auto_deny_visitor,
    run_alert_rule_evaluation,
)
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow
from workflows.alert_rule_cron import AlertRuleCronWorkflow

logger = logging.getLogger(__name__)

TASK_QUEUE = "inout-task-queue"


async def get_temporal_client() -> Client:
    return await Client.connect(settings.TEMPORAL_HOST)


async def run_worker() -> None:
    """Start the Temporal worker. Runs indefinitely."""
    client = await get_temporal_client()
    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[
            PermissionOverrideWorkflow,
            VisitorApprovalWorkflow,
            AlertRuleCronWorkflow,
        ],
        activities=[
            notify_admins_of_override,
            approve_override,
            deny_override,
            auto_deny_override,
            approve_visitor,
            deny_visitor,
            auto_deny_visitor,
            run_alert_rule_evaluation,
        ],
    )
    logger.info("Temporal worker started on task queue: %s", TASK_QUEUE)
    await worker.run()
