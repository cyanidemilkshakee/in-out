"""Authentication regressions, with real RSA signatures and mocked JWKS I/O."""
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jose import jwt, jwk


class AuthenticationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signers = {}
        cls.keys = {}
        for kid in ("old", "new"):
            private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            cls.signers[kid] = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            public = private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
            cls.keys[kid] = {**jwk.construct(public, "RS256").to_dict(), "kid": kid, "use": "sig"}

    def setUp(self):
        def patch_value(target, name, value):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        for name, value in (("_jwks_cache", None), ("_jwks_loaded_at", 0), ("_jwks_last_attempt", float("-inf"))):
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


if __name__ == "__main__":
    unittest.main()
