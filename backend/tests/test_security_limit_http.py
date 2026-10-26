"""Verified identities keep data/behavior budgets across tokens and replicas."""
import asyncio
import hashlib
import os
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, HTTPException
from auth import verify_admin_request
from config import settings
from data_limits import DataLimitsMiddleware
from request_admission import RequestAdmissionMiddleware


@unittest.skipUnless(os.getenv("TEST_REDIS_URL"), "Requires isolated Redis")
class SecurityLimitHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ["TEST_REDIS_URL"]
        if urlparse(url).hostname != "redis-test":
            raise RuntimeError("HTTP security-limit tests require isolated redis-test")
        self.redis = aioredis.from_url(url, decode_responses=True,
                                       socket_connect_timeout=10, socket_timeout=10)
        self.addAsyncCleanup(self.redis.aclose)
        prefix = "http-limits-" + uuid.uuid4().hex
        self.actors = {"alice-old": prefix + "-alice", "alice-refresh": prefix + "-alice",
                       "bob": prefix + "-bob"}
        self.mutations = []
        def claims(token, **kwargs):
            if token not in self.actors:
                raise HTTPException(401, "Invalid token")
            return {"sub": self.actors[token], "exp": time.time() + 300,
                    "realm_access": {"roles": ["admin"]}}
        self.events = AsyncMock()
        for patcher in [patch("auth.verify_keycloak_token", side_effect=claims),
                        patch("behavior_limits.get_redis_pool", return_value=self.redis),
                        patch("data_limits.get_redis_pool", return_value=self.redis),
                        patch("limit_events.record_limit_event", new=self.events),
                        patch.object(settings, "BEHAVIOR_FAILURES_PER_MINUTE", 2),
                        patch.object(settings, "DATA_BYTES_PER_MINUTE", 40)]:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.clients = []
        for _ in range(2):
            app = FastAPI()
            app.add_middleware(RequestAdmissionMiddleware)
            app.add_middleware(DataLimitsMiddleware)
            @app.post("/v1/permissions/grant", dependencies=[Depends(verify_admin_request)])
            async def grant():
                self.mutations.append("granted")
                return {"ok": True}
            @app.get("/read", dependencies=[Depends(verify_admin_request)])
            async def read():
                return {"value": "private"}
            @app.post("/invalid", dependencies=[Depends(verify_admin_request)])
            async def invalid():
                raise HTTPException(422, "Invalid operation")
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://isolated")
            self.clients.append(client)
            self.addAsyncCleanup(client.aclose)

    def headers(self, token):
        return {"Authorization": "Bearer " + token}

    async def test_rotated_tokens_and_two_replicas_share_one_write_cooldown(self):
        for client, token in zip(self.clients, ["alice-old", "alice-refresh"]):
            self.assertEqual((await client.post("/invalid", json={},
                headers=self.headers(token))).status_code, 422)
        rejected = await self.clients[1].post("/v1/permissions/grant", json={},
            headers=self.headers("alice-refresh"))
        self.assertEqual(rejected.status_code, 429)
        self.assertEqual(rejected.headers["Retry-After"], "60")
        self.assertEqual(self.mutations, [])
        self.assertEqual(self.events.await_count, 1)
        self.assertEqual((await self.clients[0].get("/read", headers=self.headers("alice-old"))).status_code, 200)
        self.assertEqual((await self.clients[0].post("/v1/permissions/grant", json={},
            headers=self.headers("bob"))).status_code, 200)

    async def test_successful_write_frequency_does_not_create_a_backend_cooldown(self):
        # Exceed the former permission action quota with real Redis checks.
        # Middleware tests cover the old 300/minute general request boundary.
        for index in range(80):
            response = await self.clients[index % 2].post("/v1/permissions/grant", json={},
                headers=self.headers("alice-old" if index % 2 else "alice-refresh"))
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.mutations), 80)
        self.events.assert_not_awaited()

    async def test_actual_bytes_share_account_budget_across_refreshed_tokens(self):
        first = await self.clients[0].get("/read", headers=self.headers("alice-old"))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(len(first.content), 19)
        self.assertEqual((await self.clients[1].get("/read", headers=self.headers("alice-refresh"))).status_code, 200)
        blocked = await self.clients[1].get("/read", headers=self.headers("alice-refresh"))
        self.assertEqual(blocked.status_code, 429)
        self.assertNotIn("private", blocked.text)
        self.assertTrue(blocked.headers["Retry-After"].isdigit())
        self.assertEqual((await self.clients[0].get("/read", headers=self.headers("bob"))).status_code, 200)

    async def test_validation_failures_trigger_cooldown_before_later_side_effects(self):
        for client in self.clients:
            self.assertEqual((await client.post("/invalid", json={}, headers=self.headers("alice-old"))).status_code, 422)
        blocked = await self.clients[0].post("/v1/permissions/grant", json={},
            headers=self.headers("alice-refresh"))
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(self.mutations, [])
        self.assertEqual(self.events.await_count, 1)

    async def test_forged_identity_headers_do_not_select_another_accounts_budget(self):
        response = await self.clients[0].post("/v1/permissions/grant", json={},
            headers={"Authorization": "Bearer forged", "X-User-ID": self.actors["bob"],
                     "X-Inout-Terminal-DN": "CN=forged-terminal"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.mutations, [])
        self.assertEqual((await self.clients[1].post("/v1/permissions/grant", json={},
            headers=self.headers("bob"))).status_code, 200)

    async def test_behavior_store_outage_rejects_before_mutation(self):
        with patch("behavior_limits.get_redis_pool", side_effect=RuntimeError("isolated")), \
             self.assertLogs("behavior_limits", level="ERROR"):
            response = await self.clients[0].post("/v1/permissions/grant", json={},
                headers=self.headers("alice-old"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.mutations, [])


if __name__ == "__main__":
    unittest.main()
