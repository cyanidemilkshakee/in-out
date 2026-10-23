"""Audit throttles without leaking bearer tokens, queries or repeated events."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import limit_events


class LimitEventTests(unittest.IsolatedAsyncioTestCase):
    def scope(self):
        return {"method": "POST", "path": "/v1/keycloak/users/private-id/password",
                "query_string": b"secret=do-not-log", "headers": [(b"authorization", b"secret-token")],
                "route": SimpleNamespace(path="/v1/keycloak/users/{user_id}/password"),
                "state": {"limit_identity": "verified-account", "limit_actor": "account-id"}}

    async def test_first_cooldown_has_a_durable_audit_without_sensitive_request_data(self):
        redis = SimpleNamespace(set=AsyncMock(return_value=True))
        session = AsyncMock()
        session.add = Mock()
        context = AsyncMock()
        context.__aenter__.return_value = session
        with patch.object(limit_events, "get_redis_pool", return_value=redis), \
             patch.object(limit_events, "AsyncSessionLocal", return_value=context), \
             self.assertLogs("limit_events", level="WARNING") as logs:
            await limit_events.record_limit_event(self.scope(), "behavior", 60, {"group": "identity"})
        event = session.add.call_args.args[0]
        session.commit.assert_awaited_once()
        self.assertEqual(event.data["category"], "security")
        self.assertEqual(event.data["actor"], "account-id")
        self.assertEqual(event.data["route"], "/v1/keycloak/users/{user_id}/password")
        self.assertNotIn("secret-token", str(event.data) + str(logs.output))
        self.assertNotIn("do-not-log", str(event.data) + str(logs.output))
        self.assertNotIn("private-id", str(event.data) + str(logs.output))
        self.assertEqual(redis.set.await_args.kwargs, {"nx": True, "ex": 60})

    async def test_repeated_cooldown_does_not_create_more_database_work(self):
        redis = SimpleNamespace(set=AsyncMock(return_value=False))
        with patch.object(limit_events, "get_redis_pool", return_value=redis), \
             patch.object(limit_events, "AsyncSessionLocal") as factory:
            await limit_events.record_limit_event(self.scope(), "behavior", 30)
        factory.assert_not_called()

    async def test_quota_outage_logs_a_hash_and_does_not_open_database(self):
        with patch.object(limit_events, "get_redis_pool", side_effect=RuntimeError("isolated")), \
             patch.object(limit_events, "AsyncSessionLocal") as factory, \
             self.assertLogs("limit_events", level="WARNING") as logs:
            await limit_events.record_limit_event(self.scope(), "data_delivery", 5)
        factory.assert_not_called()
        self.assertNotIn("verified-account", str(logs.output))
        self.assertIn("quota_unavailable", str(logs.output))

    async def test_unauthenticated_request_has_no_claimed_identity_to_audit(self):
        with patch.object(limit_events, "get_redis_pool") as pool:
            await limit_events.record_limit_event({"state": {}}, "behavior", 60)
        pool.assert_not_called()

    async def test_audit_database_outage_retains_structured_log_without_raising(self):
        redis = SimpleNamespace(set=AsyncMock(return_value=True))
        context = AsyncMock()
        context.__aenter__.side_effect = RuntimeError("isolated")
        with patch.object(limit_events, "get_redis_pool", return_value=redis), \
             patch.object(limit_events, "AsyncSessionLocal", return_value=context), \
             self.assertLogs("limit_events", level="WARNING") as logs:
            await limit_events.record_limit_event(self.scope(), "behavior", 60)
        self.assertTrue(any('"category": "security"' in line for line in logs.output))
        self.assertTrue(any("persistence failed" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
