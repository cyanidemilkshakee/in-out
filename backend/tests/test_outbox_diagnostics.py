"""Delivery retry diagnostics contain useful categories without event secrets."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import event_outbox


class OutboxDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_delivery_logs_category_and_attempt_without_sensitive_values(self):
        payload_secret = "event-payload-secret"
        provider_secret = "provider-exception-secret"
        item = SimpleNamespace(id=17, kind="presence", payload={"token": payload_secret}, attempts=2)
        db = AsyncMock()
        db.__aenter__.return_value = db
        db.scalar.return_value = item
        sessions = Mock(return_value=db)
        deliver = AsyncMock(side_effect=RuntimeError(provider_secret))

        with self.assertLogs("event_outbox", level="WARNING") as captured:
            self.assertTrue(await event_outbox.dispatch_one(deliver=deliver, sessions=sessions))

        self.assertEqual(len(captured.records), 1)
        record = captured.records[0]
        self.assertEqual((record.event_id, record.event_kind, record.error_type, record.attempt),
                         (17, "presence", "RuntimeError", 3))
        self.assertIn("RuntimeError", record.getMessage())
        self.assertIn("attempt=3", record.getMessage())
        self.assertIsNone(record.exc_info)
        self.assertNotIn(payload_secret, repr(record.__dict__))
        self.assertNotIn(provider_secret, repr(record.__dict__))
        deliver.assert_awaited_once_with("presence", {"token": payload_secret})
        self.assertEqual(db.commit.await_count, 2)
        retry_values = db.execute.await_args.args[0].compile().params
        self.assertIsNone(retry_values["lease_owner"])
        self.assertIsNone(retry_values["lease_until"])
        self.assertIn("available_at", retry_values)
        self.assertNotIn("delivered_at", retry_values)


if __name__ == "__main__":
    unittest.main()
