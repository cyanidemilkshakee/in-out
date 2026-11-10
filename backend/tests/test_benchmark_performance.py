"""Small, disposable-database smoke coverage for the performance harness."""
import os
from argparse import Namespace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark_performance import benchmark


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class PerformanceBenchmarkSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_small_fixture_runs_all_measured_paths_without_errors(self):
        report = await benchmark(Namespace(subjects=2, movements=4, alerts=1, samples=1, concurrency=1))

        self.assertIn("registryFirst25WithGlobalSummary", report["results"])
        self.assertTrue(report["results"])
        for result in report["results"].values():
            self.assertEqual([], result["errors"])
            self.assertEqual(1, result["samples"])
