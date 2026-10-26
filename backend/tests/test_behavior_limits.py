"""Behavior admission tests; integration uses only the isolated redis-test."""
import asyncio
import hashlib
import os
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import redis.asyncio as aioredis
from fastapi import HTTPException, Request

import behavior_limits as limits
from config import settings
from schemas import BrowserScanPayload
from terminal_scans import record_scan


def request_scope(path="/v1/permissions/grant", method="POST", actor="verified-alice"):
    return {"type": "http", "method": method, "path": path,
            "state": {"limit_identity": actor, "limit_actor": actor}}


class BehaviorAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_writes_check_only_actor_cooldown_without_action_counters(self):
        quota = AsyncMock(return_value=[1, 0, 0])
        writes = [("POST", "/v1/permissions/grant"),
                  ("POST", "/v1/permission-requests/REQ-1/decide"),
                  ("POST", "/v1/terminal/manual-reviews"),
                  ("POST", "/v1/registry/subjects"),
                  ("PUT", "/v1/registry/subjects/employee-1"),
                  ("DELETE", "/v1/registry/subjects/visitor-2"),
                  ("POST", "/v1/alerts/a/review"),
                  ("POST", "/v1/keycloak/users"),
                  ("POST", "/v1/alerts/evaluate"),
                  ("PUT", "/v1/alert-rule-assignments/employee-1"),
                  ("POST", "/v1/terminal/scans")]
        with patch.object(limits, "_eval", quota):
            for method, path in writes:
                await limits.enforce_behavior_admission(request_scope(path, method), "alice")
        expected = (limits._COOLDOWN_CHECK, [limits._keys("alice") + ":cooldown"])
        self.assertEqual(quota.await_count, len(writes))
        for call in quota.await_args_list:
            self.assertEqual(call.args, expected)

    async def test_multiple_auth_guards_check_once_and_reads_and_security_lock_skip(self):
        quota = AsyncMock(return_value=[1, 0, 0])
        scope = request_scope()
        with patch.object(limits, "_eval", quota):
            await limits.enforce_behavior_admission(Request(scope), "alice")
            await limits.enforce_behavior_admission(scope, "alice")
            await limits.enforce_behavior_admission(request_scope(method="GET"), "alice")
            await limits.enforce_behavior_admission(request_scope("/v1/user-management/lock"), "alice")
        self.assertEqual(quota.await_count, 1)

    async def test_successful_cooldown_check_has_no_member_or_window_debit(self):
        quota = AsyncMock(return_value=[1, 0, 0])
        with patch.object(limits, "_eval", quota):
            await limits.enforce_behavior_admission(request_scope("/v1/terminal/scans"), "alice")
        quota.assert_awaited_once_with(limits._COOLDOWN_CHECK,
                                      [limits._keys("alice") + ":cooldown"])

    async def test_existing_cooldown_rejects_with_retry_after_without_relogging(self):
        event = AsyncMock()
        with patch.object(limits, "_eval", AsyncMock(side_effect=[[0, 60, 0], [0, 48, 0]])), \
             patch.object(limits, "_event", event):
            for expected in ("60", "48"):
                with self.assertRaises(HTTPException) as caught:
                    await limits.enforce_behavior_admission(request_scope(), "alice")
                self.assertEqual(caught.exception.status_code, 429)
                self.assertEqual(caught.exception.headers["Retry-After"], expected)
                self.assertIn(expected + " seconds", caught.exception.detail)
        event.assert_not_awaited()

    async def test_denied_scan_and_anonymous_failures_never_trigger_failure_budget(self):
        quota = AsyncMock(return_value=[1, 0, 0])
        with patch.object(limits, "_eval", quota):
            await limits.record_behavior_failure(request_scope("/v1/terminal/scans"), 200)
            await limits.record_behavior_failure({"state": {}}, 403)
            await limits.record_behavior_failure(request_scope(), 429)
        quota.assert_not_awaited()

    async def test_failure_signal_counts_once_and_keeps_original_validation_response(self):
        scope = request_scope()
        event = AsyncMock()
        with patch.object(limits, "_eval", AsyncMock(return_value=[0, 60, 1])) as quota, \
             patch.object(limits, "_event", event):
            await limits.record_behavior_failure(scope, 422)
            await limits.record_behavior_failure(scope, 422)
        self.assertEqual(quota.await_count, 1)
        self.assertEqual(event.await_args.args[-1], {"signal": "repeated_validation_failures", "status": 422})

    async def test_store_outage_fails_closed(self):
        pool = SimpleNamespace(eval=AsyncMock(side_effect=RuntimeError("isolated outage")))
        with patch.object(limits, "get_redis_pool", return_value=pool), self.assertLogs("behavior_limits", level="ERROR"):
            with self.assertRaises(HTTPException) as caught:
                await limits.enforce_behavior_admission(request_scope(), "alice")
        self.assertEqual(caught.exception.status_code, 503)

    async def test_unknown_barcode_redis_keys_and_members_do_not_contain_raw_identity_or_barcode(self):
        with patch.object(limits, "_eval", AsyncMock(return_value=[1, 0, 0])) as quota:
            await limits.consume_unknown_barcode_quota("sensitive-account", " SECRET-BARCODE ")
        keys, arguments = quota.await_args.args[1], quota.await_args.args[2:]
        self.assertNotIn("sensitive-account", " ".join(keys))
        self.assertNotIn("SECRET-BARCODE", " ".join(map(str, arguments)))
        self.assertEqual(arguments[-1], hashlib.sha256(b"secret-barcode").hexdigest())


class UnknownScanAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def database(self, cached=None):
        result = Mock()
        result.scalar_one_or_none.return_value = None
        db = AsyncMock()
        db.info = {}
        db.add = Mock()
        db.execute.return_value = result
        checkpoint = SimpleNamespace(id="cp-main", data={"name": "Main Entrance", "mode": "entry"})
        db.get.side_effect = [cached] if cached else [None, checkpoint]
        return db

    async def test_fresh_unknown_scan_rejection_writes_no_movement_or_receipt(self):
        db = self.database()
        scope = request_scope("/v1/terminal/scans", actor="verified-account")
        payload = BrowserScanPayload(barcode="unknown", checkpointId="cp-main", online=False)
        with patch("terminal_scans.consume_unknown_barcode_quota", AsyncMock(
            side_effect=HTTPException(429, "cooldown", headers={"Retry-After": "60"}))) as admit:
            with self.assertRaises(HTTPException) as caught:
                await record_scan(db, uuid.uuid4(), payload, "browser:operator", request_scope=scope)
        self.assertEqual(caught.exception.status_code, 429)
        admit.assert_awaited_once_with("verified-account", "unknown", scope)
        db.add.assert_not_called()
        db.flush.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_idempotent_unknown_replay_does_not_count_or_authorize_again(self):
        cached = SimpleNamespace(terminal_id="browser:operator", subject_id=None,
            request_fingerprint=None, response_body={"allowed": False,
            "decision": {"event": {"direction": "entry", "subjectType": "visitor"}}})
        db = self.database(cached)
        payload = BrowserScanPayload(barcode="unknown", checkpointId="cp-main", online=False)
        with patch("terminal_scans.consume_unknown_barcode_quota", AsyncMock()) as admit:
            result = await record_scan(db, uuid.uuid4(), payload, "browser:operator",
                                       request_scope=request_scope("/v1/terminal/scans"))
        admit.assert_not_awaited()
        self.assertTrue(result["replayed"])
        self.assertFalse(result["authorizeMovement"])
        db.add.assert_not_called()

    async def test_unbound_domain_scan_requires_no_external_limiter_io(self):
        db = self.database()
        payload = BrowserScanPayload(barcode="unknown", checkpointId="cp-main")
        with patch("terminal_scans.consume_unknown_barcode_quota", AsyncMock()) as admit:
            result = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
        admit.assert_not_awaited()
        self.assertFalse(result["allowed"])
        self.assertEqual(db.add.call_count, 2)


@unittest.skipUnless(os.getenv("TEST_REDIS_URL"), "Set TEST_REDIS_URL for isolated Redis integration tests")
class RedisBehaviorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ["TEST_REDIS_URL"]
        if urlparse(url).hostname != "redis-test":
            raise RuntimeError("Behavior integration tests require isolated redis-test")
        self.redis = aioredis.from_url(url, decode_responses=True)
        self.addAsyncCleanup(self.redis.aclose)
        self.other_redis = aioredis.from_url(url, decode_responses=True)
        self.addAsyncCleanup(self.other_redis.aclose)
        self.identity = "behavior-test-" + uuid.uuid4().hex
        self.base = limits._keys(self.identity)
        self.used = set()
        patcher = patch.object(limits, "get_redis_pool", return_value=self.redis)
        patcher.start()
        self.addCleanup(patcher.stop)
        event = patch.object(limits, "_event", new=AsyncMock())
        self.event = event.start()
        self.addCleanup(event.stop)
        self.addAsyncCleanup(self.cleanup_keys)

    async def cleanup_keys(self):
        if self.used:
            await self.redis.delete(*self.used)

    async def test_frequent_successful_checks_across_replicas_create_no_counter(self):
        cooldown = self.base + ":cooldown"
        outcomes = []
        # Model admitted work rather than opening more simultaneous sockets
        # than the application admits. The total exceeds the former 300/minute.
        for _ in range(20):
            outcomes.extend(await asyncio.gather(*[
                (self.redis if index % 2 else self.other_redis).eval(
                    limits._COOLDOWN_CHECK, 1, cooldown)
                for index in range(20)]))
        self.assertTrue(all([int(value) for value in outcome] == [1, 0, 0]
                            for outcome in outcomes))
        self.assertFalse(await self.redis.exists(cooldown))
        # The check cannot create route frequency or failure/probing counters.
        self.assertFalse(await self.redis.exists(self.base + ":failures", self.base + ":unknown",
            self.base + ":permission:minute", self.base + ":permission:burst"))

    async def test_concurrent_failures_create_one_bounded_shared_cooldown(self):
        keys = [self.base + ":cooldown", self.base + ":failures"]
        self.used.update(keys)
        outcomes = await asyncio.gather(*[
            (self.redis if index % 2 else self.other_redis).eval(
                limits._FAILURE_RECORD, len(keys), *keys, 20, 60, uuid.uuid4().hex)
            for index in range(30)])
        self.assertEqual(sum(int(outcome[0]) for outcome in outcomes), 19)
        self.assertEqual(sum(int(outcome[2]) for outcome in outcomes), 1)
        self.assertEqual(await self.redis.zcard(keys[1]), 20)
        self.assertGreater(await self.redis.ttl(keys[0]), 0)
        self.assertLessEqual(await self.redis.ttl(keys[1]), 60)

    async def test_old_failure_signals_and_expired_cooldown_recover(self):
        keys = [self.base + ":cooldown", self.base + ":failures"]
        self.used.update(keys)
        t = await self.redis.time()
        now = int(t[0]) * 1000 + int(t[1]) // 1000
        await self.redis.zadd(keys[1], {"old-a": now - 61000, "old-b": now - 61000})
        admitted = await limits._eval(limits._FAILURE_RECORD, keys, 2, 1, uuid.uuid4().hex)
        self.assertEqual([int(value) for value in admitted], [1, 0, 0])
        self.assertEqual(await self.redis.zcard(keys[1]), 1)
        blocked = await limits._eval(limits._FAILURE_RECORD, keys, 2, 1, uuid.uuid4().hex)
        self.assertEqual([int(value) for value in blocked], [0, 1, 1])
        # Only this unique test actor has a deliberately short cooldown.
        await asyncio.sleep(1.1)
        recovered = await limits._eval(limits._COOLDOWN_CHECK, [keys[0]])
        self.assertEqual([int(value) for value in recovered], [1, 0, 0])

    async def test_unknown_counts_distinct_normalized_barcodes_once_and_isolates_actors(self):
        keys = [self.base + ":cooldown", self.base + ":unknown"]
        self.used.update(keys)
        other = self.identity + "-other"
        self.used.update([limits._keys(other) + ":cooldown", limits._keys(other) + ":unknown"])
        with patch.object(settings, "BEHAVIOR_UNKNOWN_BARCODES_PER_MINUTE", 2):
            await limits.consume_unknown_barcode_quota(self.identity, " FIRST ")
            await limits.consume_unknown_barcode_quota(self.identity, "first")
            await limits.consume_unknown_barcode_quota(self.identity, "second")
            with self.assertRaises(HTTPException) as caught:
                await limits.consume_unknown_barcode_quota(self.identity, "third")
            await limits.consume_unknown_barcode_quota(other, "third")
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers["Retry-After"], "60")
        self.assertEqual(await self.redis.zcard(keys[1]), 2)
        self.assertLessEqual(await self.redis.ttl(keys[1]), 60)

    async def test_failure_cooldown_blocks_writes_keeps_reads_and_never_extends(self):
        self.used.update([self.base + ":cooldown", self.base + ":failures"])
        with patch.object(settings, "BEHAVIOR_FAILURES_PER_MINUTE", 2):
            await limits.record_behavior_failure(request_scope(actor=self.identity), 403)
            await limits.record_behavior_failure(request_scope(actor=self.identity), 422)
        cooldown = self.base + ":cooldown"
        await self.redis.expire(cooldown, 3)
        with self.assertRaises(HTTPException) as caught:
            await limits.enforce_behavior_admission(request_scope("/v1/terminal/scans", actor=self.identity), self.identity)
        self.assertLessEqual(int(caught.exception.headers["Retry-After"]), 3)
        await limits.enforce_behavior_admission(request_scope(method="GET", actor=self.identity), self.identity)
        await limits.enforce_behavior_admission(request_scope("/v1/user-management/lock", actor=self.identity), self.identity)
        await limits.record_behavior_failure(request_scope(actor=self.identity), 403)
        self.assertLessEqual(await self.redis.ttl(cooldown), 3)
        self.assertEqual(self.event.await_count, 1)


if __name__ == "__main__":
    unittest.main()
