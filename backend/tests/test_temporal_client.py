"""HTTP startup and shared Temporal transport lifecycle regressions."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import temporal_worker


class TemporalClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await temporal_worker.close_temporal_client()

    async def test_concurrent_requests_share_connection_and_cancellation_isolated(self):
        started, finish = asyncio.Event(), asyncio.Event()
        client = object()

        async def connect(_target):
            started.set()
            await finish.wait()
            return client

        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=connect)) as connect_mock:
            requests = [asyncio.create_task(temporal_worker.get_temporal_client()) for _ in range(12)]
            await started.wait()
            requests[0].cancel()
            with self.assertRaises(asyncio.CancelledError):
                await requests[0]
            finish.set()
            self.assertTrue(all(result is client for result in await asyncio.gather(*requests[1:])))
            self.assertIs(await temporal_worker.get_temporal_client(), client)
            connect_mock.assert_awaited_once_with(temporal_worker.settings.TEMPORAL_HOST)

    async def test_failed_connection_can_retry(self):
        client = object()
        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=[RuntimeError("offline"), client])) as connect:
            with self.assertRaisesRegex(RuntimeError, "offline"):
                await temporal_worker.get_temporal_client()
            self.assertIs(await temporal_worker.get_temporal_client(), client)
            self.assertEqual(connect.await_count, 2)

    async def test_connection_timeout_can_retry(self):
        cancelled = asyncio.Event()

        async def stalled(_target):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch.object(temporal_worker, "_CONNECT_TIMEOUT_SECONDS", 0.02), \
             patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=stalled)):
            with self.assertRaises(TimeoutError):
                await temporal_worker.get_temporal_client()
            self.assertTrue(cancelled.is_set())
        client = object()
        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(return_value=client)):
            self.assertIs(await temporal_worker.get_temporal_client(), client)

    async def test_host_change_and_lifecycle_restart_get_new_clients(self):
        clients = [object(), object(), object()]
        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=clients)) as connect:
            with patch.object(temporal_worker.settings, "TEMPORAL_HOST", "temporal-one:7233"):
                self.assertIs(await temporal_worker.get_temporal_client(), clients[0])
            with patch.object(temporal_worker.settings, "TEMPORAL_HOST", "temporal-two:7233"):
                self.assertIs(await temporal_worker.get_temporal_client(), clients[1])
                await temporal_worker.close_temporal_client()
                self.assertIs(await temporal_worker.get_temporal_client(), clients[2])
            self.assertEqual([call.args[0] for call in connect.await_args_list],
                ["temporal-one:7233", "temporal-two:7233", "temporal-two:7233"])

    async def test_shutdown_cancels_pending_connection(self):
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def connect(_target):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=connect)):
            request = asyncio.create_task(temporal_worker.get_temporal_client())
            await started.wait()
            await temporal_worker.close_temporal_client()
            with self.assertRaises(asyncio.CancelledError):
                await request
            self.assertTrue(cancelled.is_set())


class TemporalClientLoopTests(unittest.TestCase):
    def test_separate_event_loops_never_share_clients(self):
        clients = [object(), object()]
        with patch.object(temporal_worker.Client, "connect", new=AsyncMock(side_effect=clients)) as connect:
            self.assertIs(asyncio.run(temporal_worker.get_temporal_client()), clients[0])
            self.assertIs(asyncio.run(temporal_worker.get_temporal_client()), clients[1])
            self.assertEqual(connect.await_count, 2)

    def test_http_import_does_not_load_workflow_worker(self):
        environment = {**os.environ,
            "DATABASE_URL": "postgresql+asyncpg://test:test@127.0.0.1:5432/import_only",
            "READ_DATABASE_URL": "postgresql+asyncpg://test:test@127.0.0.1:5432/import_only"}
        program = """import sys
import main
assert 'temporalio.worker' not in sys.modules
assert 'workflows.activities' not in sys.modules
assert 'workflows.permission_override' not in sys.modules
assert 'workflows.visitor_approval' not in sys.modules
"""
        result = subprocess.run([sys.executable, "-c", program],
            cwd=Path(__file__).resolve().parents[1], env=environment,
            timeout=90, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
