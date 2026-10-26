"""Authentication regressions, with real RSA signatures and mocked JWKS I/O."""
import asyncio
import sys
import time
import json
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, HTTPException
import jwt


class AuthenticationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signers = {}
        cls.keys = {}
        for kid in ("old", "new"):
            private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            cls.signers[kid] = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            cls.keys[kid] = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())),
                "kid": kid, "use": "sig", "alg": "RS256"}

    def setUp(self):
        def patch_value(target, name, value):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        for name, value in (("_jwks_cache", None), ("_jwks_loaded_at", 0),
                            ("_jwks_snapshot", None), ("_jwks_refresh_task", None),
                            ("_jwks_last_attempt", float("-inf"))):
            patch_value(auth, name, value)
        patch_value(auth.settings, "KEYCLOAK_ISSUER", "https://identity.test/realms/inout")
        patch_value(auth.settings, "KEYCLOAK_AUDIENCE", "inout-frontend")
        patch_value(auth.settings, "KEYCLOAK_JWKS_CACHE_TTL", 300)

    def claims(self):
        return {"sub": "user-123", "iss": auth.settings.KEYCLOAK_ISSUER, "aud": "inout-frontend", "exp": int(time.time()) + 300,
                "typ": "Bearer", "realm_access": {"roles": ["admin"]}}

    def token(self, claims=None, kid="old", header_kid=None):
        return jwt.encode(self.claims() if claims is None else claims, self.signers[kid], algorithm="RS256", headers={"kid": header_kid or kid})

    def response(self, *kids):
        return httpx.Response(200, json={"keys": [self.keys[kid] for kid in kids]}, request=httpx.Request("GET", "https://identity.test/certs"))

    def assert_unauthorized(self, token):
        with self.assertRaises(HTTPException) as error:
            auth.verify_keycloak_token(token)
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(error.exception.headers["WWW-Authenticate"], "Bearer")

    def test_required_claims_cannot_be_omitted(self):
        with patch("auth.httpx.get", return_value=self.response("old")):
            for name in ("exp", "iss", "aud", "sub", "typ"):
                with self.subTest(name=name):
                    claims = self.claims()
                    del claims[name]
                    self.assert_unauthorized(self.token(claims))

    def test_invalid_issuer_audience_expiry_and_id_token_are_rejected(self):
        with patch("auth.httpx.get", return_value=self.response("old")):
            for name, value in (("iss", "https://attacker.test"), ("aud", "other-api"), ("exp", int(time.time()) - 60),
                                ("typ", "ID"), ("sub", ""), ("nbf", int(time.time()) + 300)):
                with self.subTest(name=name):
                    self.assert_unauthorized(self.token({**self.claims(), name: value}))

    def test_valid_token_with_multiple_audiences(self):
        with patch("auth.httpx.get", return_value=self.response("old")):
            payload = auth.verify_keycloak_token(self.token({**self.claims(), "aud": ["account", "inout-frontend"]}))
            self.assertTrue(auth.has_admin_role(payload))

    def test_master_admin_inherits_application_admin_access_but_remains_distinct(self):
        payload = {"realm_access": {"roles": ["master-admin"]}}
        self.assertTrue(auth.has_admin_role(payload))
        self.assertTrue(auth.has_master_admin_role(payload))
        self.assertFalse(auth.has_operator_role(payload))
        self.assertFalse(auth.has_master_admin_role({"realm_access": {"roles": ["admin"]}}))

    def test_invalid_signature_and_mislabelled_kid_are_rejected(self):
        with patch("auth.httpx.get", return_value=self.response("old", "new")):
            self.assert_unauthorized(self.token(kid="new", header_kid="old"))

    def test_malformed_and_wrong_algorithm_tokens_do_not_fetch_keys(self):
        with patch("auth.httpx.get") as fetch:
            self.assert_unauthorized("malformed")
            self.assert_unauthorized(jwt.encode(self.claims(), "not-a-key", algorithm="HS256", headers={"kid": "old"}))
            self.assert_unauthorized(jwt.encode(self.claims(), self.signers["old"], algorithm="RS256"))
            fetch.assert_not_called()

    def test_key_rotation_refreshes_without_restart(self):
        with patch("auth.time.monotonic", return_value=100) as clock, patch("auth.httpx.get", side_effect=[self.response("old"), self.response("old", "new")]) as fetch:
            auth.verify_keycloak_token(self.token())
            clock.return_value = 131
            self.assertEqual(auth.verify_keycloak_token(self.token(kid="new"))["sub"], "user-123")
            self.assertEqual(fetch.call_count, 2)

    def test_unknown_kid_requests_are_rate_limited(self):
        with patch("auth.time.monotonic", return_value=100) as clock, patch("auth.httpx.get", return_value=self.response("old")) as fetch:
            auth.verify_keycloak_token(self.token())
            clock.return_value = 131
            for index in range(10):
                self.assert_unauthorized(self.token(header_kid=f"untrusted-{index}"))
            self.assertEqual(fetch.call_count, 2)
            self.assertTrue(auth.has_admin_role(auth.verify_keycloak_token(self.token())))

    def test_expired_cache_removes_retired_key(self):
        with patch("auth.time.monotonic", return_value=100) as clock, patch("auth.httpx.get", side_effect=[self.response("old"), self.response("new")]):
            auth.verify_keycloak_token(self.token())
            clock.return_value = 401
            self.assert_unauthorized(self.token())
            self.assertEqual(auth.verify_keycloak_token(self.token(kid="new"))["sub"], "user-123")

    def test_unavailable_jwks_fails_closed_and_backs_off(self):
        with patch("auth.time.monotonic", return_value=100), patch("auth.httpx.get", side_effect=httpx.ConnectError("offline")) as fetch:
            for _ in range(3):
                with self.assertRaises(HTTPException) as error:
                    auth.verify_keycloak_token(self.token())
                self.assertEqual(error.exception.status_code, 503)
            self.assertEqual(fetch.call_count, 1)

    def test_expired_cache_is_not_used_during_an_outage(self):
        with patch("auth.time.monotonic", return_value=100) as clock, patch("auth.httpx.get", side_effect=[self.response("old"), httpx.ConnectError("offline")]):
            auth.verify_keycloak_token(self.token())
            clock.return_value = 401
            with self.assertRaises(HTTPException) as error:
                auth.verify_keycloak_token(self.token())
            self.assertEqual(error.exception.status_code, 503)

    def test_malformed_jwks_is_service_unavailable(self):
        with patch("auth.httpx.get", return_value=Mock(json=lambda: {"keys": "invalid"})):
            with self.assertRaises(HTTPException) as error:
                auth.verify_keycloak_token(self.token())
            self.assertEqual(error.exception.status_code, 503)

    def test_malformed_roles_fail_closed(self):
        for access in (None, "admin", {"roles": "not-admin"}, {"roles": None}, {"roles": [1, "not-admin"]}):
            self.assertFalse(auth.has_admin_role({"realm_access": access}))
            self.assertFalse(auth.has_operator_role({"realm_access": access}))

    def test_slow_unknown_key_refresh_does_not_block_fresh_known_key(self):
        entered, release = threading.Event(), threading.Event()
        def delayed(*_args, **_kwargs):
            entered.set()
            if not release.wait(2):
                raise AssertionError("Test refresh release timed out")
            return self.response("old", "new")
        with patch("auth.httpx.get", return_value=self.response("old")), \
             patch("auth.time.monotonic", return_value=100):
            auth.verify_keycloak_token(self.token())
        with patch("auth.httpx.get", side_effect=delayed), patch("auth.time.monotonic", return_value=131):
            with ThreadPoolExecutor(max_workers=3) as pool:
                refresh = pool.submit(auth.verify_keycloak_token, self.token(kid="new"))
                try:
                    self.assertTrue(entered.wait(1))
                    known = pool.submit(auth.verify_keycloak_token, self.token())
                    self.assertEqual(known.result(timeout=0.5)["sub"], "user-123")
                    unknown = pool.submit(auth.verify_keycloak_token, self.token(header_kid="attacker-unknown"))
                    with self.assertRaises(HTTPException) as denied:
                        unknown.result(timeout=0.5)
                    self.assertEqual(denied.exception.status_code, 401)
                finally:
                    release.set()
                self.assertEqual(refresh.result(timeout=1)["sub"], "user-123")

    def test_expired_keys_fail_closed_without_waiting_for_inflight_refresh(self):
        with patch("auth.httpx.get", return_value=self.response("old")) as fetch, \
             patch("auth.time.monotonic", return_value=100) as clock:
            auth.verify_keycloak_token(self.token())
            clock.return_value = 401
            with ThreadPoolExecutor(max_workers=1) as pool:
                auth._jwks_lock.acquire()
                try:
                    waiting = pool.submit(auth.verify_keycloak_token, self.token())
                    with self.assertRaises(HTTPException) as denied:
                        waiting.result(timeout=0.5)
                    self.assertEqual(denied.exception.status_code, 503)
                    self.assertEqual(fetch.call_count, 1)
                finally:
                    auth._jwks_lock.release()


class ConcurrentAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(AuthenticationTests.setUpClass.__func__)
    setUp = AuthenticationTests.setUp
    claims = AuthenticationTests.claims
    token = AuthenticationTests.token
    response = AuthenticationTests.response

    async def parallel_requests(self, token, count=24):
        app = FastAPI()
        @app.get("/protected")
        async def protected(claims=Depends(auth.verify_admin_request)):
            return {"subject": claims["sub"]}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            return await asyncio.gather(*(client.get("/protected", headers={"Authorization": "Bearer " + token})
                                          for _ in range(count)))

    async def test_cold_start_parallel_requests_join_one_key_fetch(self):
        token = self.token()
        def fetch(*args, **kwargs):
            time.sleep(0.1)
            return self.response("old")
        with patch("auth.httpx.get", side_effect=fetch) as fetch_keys:
            responses = await self.parallel_requests(token)
        self.assertEqual([r.status_code for r in responses], [200] * 24)
        self.assertEqual(fetch_keys.call_count, 1)

    async def test_expired_cache_parallel_requests_join_refresh_and_remove_retired_key(self):
        with patch("auth.httpx.get", return_value=self.response("old")), patch("auth.time.monotonic", return_value=100):
            auth.verify_keycloak_token(self.token())
        def fetch(*args, **kwargs):
            time.sleep(0.1)
            return self.response("new")
        with patch("auth.httpx.get", side_effect=fetch) as fetch_keys:
            responses = await self.parallel_requests(self.token(kid="new"))
            retired = await self.parallel_requests(self.token(), count=1)
        self.assertEqual([r.status_code for r in responses], [200] * 24)
        self.assertEqual(retired[0].status_code, 401)
        self.assertEqual(fetch_keys.call_count, 1)

    async def test_rotating_key_requests_share_refresh_while_known_keys_bypass_fetch(self):
        with patch("auth.httpx.get", return_value=self.response("old")):
            auth.verify_keycloak_token(self.token())
        auth._jwks_last_attempt -= auth._JWKS_MIN_REFRESH_INTERVAL + 1
        entered, release = threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            entered.set()
            if not release.wait(30):
                raise AssertionError("Test refresh release timed out")
            return self.response("old", "new")
        with patch("auth.httpx.get", side_effect=fetch) as fetch_keys:
            rotating = asyncio.create_task(self.parallel_requests(self.token(kid="new")))
            try:
                # Verify independence from the blocked refresh rather than a
                # subsecond wall-clock deadline that depends on host load.
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                known = await asyncio.wait_for(self.parallel_requests(self.token(), count=1), 5)
                self.assertEqual(known[0].status_code, 200)
                self.assertFalse(release.is_set())
                self.assertFalse(rotating.done())
            finally:
                release.set()
            responses = await asyncio.wait_for(rotating, 5)
        self.assertEqual([r.status_code for r in responses], [200] * 24)
        self.assertEqual(fetch_keys.call_count, 1)

    async def test_cache_expiry_after_preparation_does_not_trigger_a_second_fetch(self):
        with patch("auth.httpx.get", return_value=self.response("old")):
            auth.verify_keycloak_token(self.token())
        worker = auth.run_in_threadpool
        async def expire_before_verification(func, *args, **kwargs):
            if func is auth.verify_keycloak_token:
                auth._jwks_loaded_at -= auth.settings.KEYCLOAK_JWKS_CACHE_TTL + 1
                auth._jwks_snapshot = (auth._jwks_cache, auth._jwks_loaded_at)
            return await worker(func, *args, **kwargs)
        with patch("auth.run_in_threadpool", side_effect=expire_before_verification), \
             patch("auth.httpx.get") as fetch_keys:
            responses = await self.parallel_requests(self.token(), count=1)
        self.assertEqual(responses[0].status_code, 200)
        fetch_keys.assert_not_called()

    async def test_parallel_fetch_outage_fails_closed_with_one_network_attempt(self):
        def fetch(*args, **kwargs):
            time.sleep(0.1)
            raise httpx.ConnectError("offline")
        with patch("auth.httpx.get", side_effect=fetch) as fetch_keys:
            responses = await self.parallel_requests(self.token())
        self.assertEqual([r.status_code for r in responses], [503] * 24)
        self.assertEqual(fetch_keys.call_count, 1)

    async def test_disconnected_waiter_does_not_cancel_other_requests_refresh(self):
        entered, release = threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise AssertionError("Test refresh release timed out")
            return self.response("old")
        token = self.token()
        with patch("auth.httpx.get", side_effect=fetch) as fetch_keys:
            first = asyncio.create_task(auth._prepare_jwks(token))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                second = asyncio.create_task(auth._prepare_jwks(token))
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                self.assertFalse(auth._jwks_refresh_task.cancelled())
            finally:
                release.set()
            await asyncio.wait_for(second, 1)
            self.assertEqual(auth.verify_keycloak_token(token)["sub"], "user-123")
        self.assertEqual(fetch_keys.call_count, 1)

    async def test_malformed_tokens_do_not_start_a_shared_fetch(self):
        with patch("auth.httpx.get") as fetch:
            for token in ("malformed", jwt.encode(self.claims(), "wrong-key", algorithm="HS256", headers={"kid": "old"})):
                responses = await self.parallel_requests(token, count=1)
                self.assertEqual(responses[0].status_code, 401)
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
