"""Durable workflow fixture; prepare, restart server, then complete and replay."""
import argparse
import asyncio
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.worker import Worker, UnsandboxedWorkflowRunner

from bootstrap_namespace import bootstrap

WORKFLOW_ID = "inout-isolated-temporal-compatibility"
TASK_QUEUE = "inout-isolated-temporal-compatibility"


@activity.defn
async def fixture_echo(value: str) -> str:
    return value


@workflow.defn
class DurableFixture:
    def __init__(self):
        self.waiting = False
        self.released = False

    @workflow.run
    async def run(self) -> str:
        value = await workflow.execute_activity(fixture_echo, "persisted",
            start_to_close_timeout=timedelta(seconds=10))
        self.waiting = True
        await workflow.wait_condition(lambda: self.released)
        return await workflow.execute_activity(fixture_echo, value + "-replayed",
            start_to_close_timeout=timedelta(seconds=10))

    @workflow.query
    def stage(self) -> bool:
        return self.waiting

    @workflow.signal
    def release(self):
        self.released = True


async def run(args):
    client = await bootstrap()
    async with Worker(client, task_queue=TASK_QUEUE, workflows=[DurableFixture],
                      activities=[fixture_echo], workflow_runner=UnsandboxedWorkflowRunner()):
        if args.prepare:
            handle = await client.start_workflow(DurableFixture.run, id=WORKFLOW_ID,
                task_queue=TASK_QUEUE, execution_timeout=timedelta(minutes=15))
            for _ in range(60):
                if await handle.query(DurableFixture.stage):
                    print("PASS: workflow persisted its first activity and is awaiting a signal")
                    return
                await asyncio.sleep(0.5)
            raise AssertionError("Workflow did not reach its durable wait")
        handle = client.get_workflow_handle(WORKFLOW_ID)
        assert await handle.query(DurableFixture.stage), "Workflow state did not replay after server/worker restart"
        await handle.signal(DurableFixture.release)
        assert await asyncio.wait_for(handle.result(), 30) == "persisted-replayed"
        history = await handle.fetch_history()
        completed = [event for event in history.events if event.HasField("activity_task_completed_event_attributes")]
        assert len(completed) == 2, "Durable history lost or duplicated activity completion"
        print("PASS: workflow replayed after restart, accepted its signal and completed with two persisted activities")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true")
    arguments = parser.parse_args()
    asyncio.run(asyncio.wait_for(run(arguments), 100))
