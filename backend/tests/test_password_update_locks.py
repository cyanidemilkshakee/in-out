"""Internal password-update coordination trusts only bounded BFF proofs."""
import hashlib
import hmac
import json
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
import httpx

from routers import password_updates


class PasswordUpdateLockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.secret = "synthetic-password-update-coordination-secret"
        self.app = FastAPI()
        self.app.include_router(password_updates.router)
        self.redis = AsyncMock()
        self.redis.set.return_value = True
        self.redis.eval.return_value = 0
        self.subject = "fixture-account-subject"
        self.lease_id = str(uuid.uuid4())
        for target, value in (
            ("routers.password_updates.settings.KEYCLOAK_STEP_UP_SIGNING_SECRET", self.secret),
            ("routers.password_updates.get_redis_pool", lambda: self.redis),
        ):
            item = patch(target, value)
            item.start()
            self.addCleanup(item.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(self.app), base_url="http://isolated")
        self.addAsyncCleanup(self.client.aclose)

    def payload(self, **changes):
        return {"subject": self.subject, "leaseId": self.lease_id, "action": "acquire", **changes}

    def headers(self, raw, timestamp=None):
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        message = b"inout:password-update-lease:v1\n" + timestamp.encode() + b"\n" + raw
        return {"Content-Type": "application/json", "X-Inout-Password-Lease-Time": timestamp,
                "X-Inout-Password-Lease-Signature": hmac.new(self.secret.encode(), message, hashlib.sha256).hexdigest()}

    async def send(self, payload=None, raw=None, **options):
        raw = raw if raw is not None else json.dumps(payload or self.payload(), separators=(",", ":")).encode()
        headers = options.pop("headers", self.headers(raw))
        return await self.client.post("/internal/password-updates/lease", content=raw, headers=headers, **options)

    async def test_valid_acquire_uses_hashed_subject_expiry_and_unique_owner(self):
        response = await self.send()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        expected_key = "inout:security-limits:password-update:lease:" + hashlib.sha256(self.subject.encode()).hexdigest()
        self.redis.set.assert_awaited_once_with(expected_key, self.lease_id, nx=True, ex=90)
        self.assertNotIn(self.subject, expected_key)

    async def test_busy_acquire_is_conflict_without_exposing_owner(self):
        self.redis.set.return_value = False
        response = await self.send()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.headers.get("Retry-After"), "5")
        self.assertNotIn(self.lease_id, response.text)
        self.redis.eval.assert_not_awaited()

    async def test_release_compares_owner_atomically_and_is_idempotent(self):
        for result in (0, 1, 0):
            self.redis.eval.return_value = result
            response = await self.send(self.payload(action="release"))
            self.assertEqual(response.status_code, 200)
        self.redis.set.assert_not_awaited()
        script, number, key, owner = self.redis.eval.await_args.args
        self.assertEqual(number, 1)
        self.assertEqual(owner, self.lease_id)
        self.assertIn("redis.call('GET', KEYS[1]) == ARGV[1]", script)
        self.assertIn("redis.call('DEL', KEYS[1])", script)
        self.assertTrue(key.endswith(hashlib.sha256(self.subject.encode()).hexdigest()))

    async def test_bad_or_expired_proofs_never_contact_redis(self):
        raw = json.dumps(self.payload()).encode()
        variants = [self.headers(raw, int(time.time()) - 16), self.headers(raw, int(time.time()) + 16),
                    {**self.headers(raw), "X-Inout-Password-Lease-Signature": "0" * 64},
                    {**self.headers(raw), "X-Inout-Password-Lease-Time": "1e9"},
                    {"Content-Type": "application/json"}]
        for headers in variants:
            with self.subTest(headers=list(headers)):
                response = await self.send(raw=raw, headers=headers)
                self.assertEqual(response.status_code, 401)
        self.redis.set.assert_not_awaited()

    async def test_proof_binds_exact_body_bytes_and_timestamp(self):
        raw = json.dumps(self.payload()).encode()
        for changed in (raw + b" ", json.dumps(self.payload(subject="another-account")).encode()):
            response = await self.send(raw=changed, headers=self.headers(raw))
            self.assertEqual(response.status_code, 401)
        self.redis.set.assert_not_awaited()

    async def test_malformed_payloads_and_unknown_fields_are_rejected(self):
        payloads = [self.payload(unknown=True), self.payload(subject=""), self.payload(subject="x" * 129),
                    self.payload(subject=1), self.payload(leaseId="not-a-uuid"),
                    self.payload(leaseId=str(uuid.uuid1())), self.payload(action="renew"), []]
        for payload in payloads:
            with self.subTest(kind=type(payload).__name__):
                raw = json.dumps(payload).encode()
                response = await self.send(raw=raw)
                self.assertEqual(response.status_code, 422)
        raw = b'{"subject":"a","subject":"b","leaseId":"' + self.lease_id.encode() + b'","action":"acquire"}'
        self.assertEqual((await self.send(raw=raw)).status_code, 422)
        self.redis.set.assert_not_awaited()

    async def test_oversized_and_non_json_bodies_are_rejected(self):
        raw = b"x" * 1025
        self.assertEqual((await self.send(raw=raw)).status_code, 413)
        headers = {**self.headers(b"{}"), "Content-Type": "text/plain"}
        self.assertEqual((await self.send(raw=b"{}", headers=headers)).status_code, 415)
        self.redis.set.assert_not_awaited()

    async def test_redis_errors_and_timeout_fail_closed_without_details(self):
        for error in (RuntimeError(self.subject + self.lease_id), TimeoutError("synthetic timeout")):
            self.redis.set.side_effect = error
            response = await self.send()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.headers.get("Retry-After"), "5")
            self.assertNotIn(self.subject, response.text)
            self.assertNotIn(self.lease_id, response.text)

    async def test_unconfigured_signing_secret_fails_closed(self):
        with patch("routers.password_updates.settings.KEYCLOAK_STEP_UP_SIGNING_SECRET", ""):
            response = await self.send()
        self.assertEqual(response.status_code, 503)
        self.redis.set.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
