"""
Temporal Worker — connects to the Temporal server and processes workflow/activity tasks.
Run as its own service so worker failures are supervised separately from the
HTTP API process.
"""
from __future__ import annotations

import logging
import asyncio
from dataclasses import dataclass

from temporalio.client import Client

from config import settings

logger = logging.getLogger(__name__)

TASK_QUEUE = "inout-task-queue"
_CONNECTION_ATTRIBUTE = "_inout_temporal_connection"
_CONNECT_TIMEOUT_SECONDS = 5.0


@dataclass
class _Connection:
    target: str
    task: asyncio.Task[Client]


async def _connect(target: str) -> Client:
    return await asyncio.wait_for(Client.connect(target), timeout=_CONNECT_TIMEOUT_SECONDS)


def _observe_connection_result(task: asyncio.Task[Client]) -> None:
    # A cancelled HTTP request must not cancel a connection shared with other
    # requests. Observe failures even if all waiting requests were cancelled.
    if not task.cancelled():
        task.exception()


async def get_temporal_client() -> Client:
    """Share one reconnecting SDK client, and one connection attempt, per loop."""
    loop = asyncio.get_running_loop()
    connection = getattr(loop, _CONNECTION_ATTRIBUTE, None)
    target = settings.TEMPORAL_HOST
    if connection is not None and connection.target != target:
        if not connection.task.done():
            connection.task.cancel()
        connection = None
    if connection is not None and connection.task.done():
        if connection.task.cancelled() or connection.task.exception() is not None:
            connection = None
    if connection is None:
        task = loop.create_task(_connect(target))
        task.add_done_callback(_observe_connection_result)
        connection = _Connection(target, task)
        # The loop owns the cache, rather than a global dictionary retaining
        # closed loops and their clients across tests or application restarts.
        setattr(loop, _CONNECTION_ATTRIBUTE, connection)
    return await asyncio.shield(connection.task)


async def close_temporal_client() -> None:
    """Release this process lifecycle's client and cancel an unfinished connect.

    The Python SDK owns transport reconnection and has no public Client.close.
    A successful client can be discarded without shutting down its shared runtime.
    """
    loop = asyncio.get_running_loop()
    connection = getattr(loop, _CONNECTION_ATTRIBUTE, None)
    if connection is None:
        return
    delattr(loop, _CONNECTION_ATTRIBUTE)
    if not connection.task.done():
        connection.task.cancel()
        try:
            await connection.task
        except asyncio.CancelledError:
            pass


async def run_worker() -> None:
    """Start the Temporal worker. Runs indefinitely."""
    # HTTP routes use only the client. Load the workflow runner and activities
    # exclusively in this dedicated worker process.
    from temporalio.worker import Worker
    from event_outbox import run_dispatcher
    from workflows.activities import (
        approve_override, deny_override, auto_deny_override,
        approve_visitor, deny_visitor, auto_deny_visitor,
        run_alert_rule_evaluation,
    )
    from workflows.permission_override import PermissionOverrideWorkflow
    from workflows.visitor_approval import VisitorApprovalWorkflow
    from workflows.alert_rule_cron import AlertRuleCronWorkflow

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
    stop = asyncio.Event()
    dispatcher = asyncio.create_task(run_dispatcher(stop), name="durable-event-dispatcher")
    runner = asyncio.create_task(worker.run(), name="temporal-workflow-worker")
    try:
        done, _ = await asyncio.wait((runner, dispatcher), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        if dispatcher in done:
            raise RuntimeError("Durable event dispatcher exited while the worker was running")
    finally:
        stop.set()
        if not runner.done():
            await worker.shutdown()
        if not dispatcher.done():
            dispatcher.cancel()
        await asyncio.gather(runner, dispatcher, return_exceptions=True)
        await close_temporal_client()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
