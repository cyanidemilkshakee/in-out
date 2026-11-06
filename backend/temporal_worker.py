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
_WORKER_RETRY_INITIAL_SECONDS = 1.0
_WORKER_RETRY_MAX_SECONDS = 30.0


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


async def _run_temporal_worker_once(stop: asyncio.Event) -> None:
    """Run one workflow-worker lifecycle, independently of event delivery."""
    # HTTP routes use only the client. Load the workflow runner and activities
    # exclusively in this dedicated worker process.
    from temporalio.worker import Worker
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
    runner = asyncio.create_task(worker.run(), name="temporal-workflow-worker")
    stopping = asyncio.create_task(stop.wait(), name="temporal-worker-stopping")
    try:
        done, _ = await asyncio.wait((runner, stopping), return_when=asyncio.FIRST_COMPLETED)
        if runner in done:
            runner.result()
            if not stop.is_set():
                raise RuntimeError("Temporal workflow worker exited unexpectedly")
    finally:
        try:
            if not runner.done():
                await worker.shutdown()
        except BaseException:
            runner.cancel()
            raise
        finally:
            stopping.cancel()
            await asyncio.gather(runner, stopping, return_exceptions=True)


async def _run_temporal_worker(stop: asyncio.Event) -> None:
    delay = _WORKER_RETRY_INITIAL_SECONDS
    while not stop.is_set():
        try:
            await _run_temporal_worker_once(stop)
            return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Provider errors can include credentials/URLs. Report the category
            # while allowing live presence delivery to keep running.
            logger.warning("Temporal workflow worker unavailable; retrying", extra={
                "error_type": type(error).__name__, "retry_after": delay})
            # get_temporal_client discards failed connection attempts itself.
            # Do not cancel the shared cache here: another delivery may already
            # have started a replacement connection after this attempt failed.
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            delay = min(_WORKER_RETRY_MAX_SECONDS, delay * 2)


async def run_worker() -> None:
    """Supervise durable delivery and reconnecting Temporal work independently."""
    from event_outbox import run_dispatcher

    stop = asyncio.Event()
    dispatcher = asyncio.create_task(run_dispatcher(stop), name="durable-event-dispatcher")
    runner = asyncio.create_task(_run_temporal_worker(stop), name="temporal-worker-supervisor")
    try:
        done, _ = await asyncio.wait((runner, dispatcher), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        raise RuntimeError("Worker lifecycle task exited unexpectedly")
    finally:
        stop.set()
        for task in (runner, dispatcher):
            if not task.done():
                task.cancel()
        await asyncio.gather(runner, dispatcher, return_exceptions=True)
        await close_temporal_client()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
