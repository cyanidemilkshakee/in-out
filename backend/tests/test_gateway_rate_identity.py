"""Private quota identity callback: real RSA/JWKS verification, no data access."""
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth
from main import app
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


class GatewayRateIdentityTests(unittest.IsolatedAsyncioTestCase):
    secret = "isolated-kong-identity-secret-at-least-32-characters"
    issuer = "https://identity.test/realms/inout"

    @classmethod
    def setUpClass(cls):
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.signer = private.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        cls.key = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())),
                   "kid": "gateway-test", "use": "sig", "alg": "RS256"}

    def setUp(self):
        for target, values in ((auth.settings, {"KONG_IDENTITY_SECRET": self.secret,
                "KEYCLOAK_ISSUER": self.issuer, "KEYCLOAK_AUDIENCE": "inout-frontend"}),
                (auth, {"_jwks_cache": None, "_jwks_loaded_at": 0,
                    "_jwks_snapshot": None, "_jwks_refresh_task": None,
                    "_jwks_last_attempt": float("-inf")})):
            for name, value in values.items():
                patcher = patch.object(target, name, value)
                patcher.start()
                self.addCleanup(patcher.stop)
        response = httpx.Response(200, json={"keys": [self.key]},
                                  request=httpx.Request("GET", "https://identity.test/certs"))
        patcher = patch("auth.httpx.get", return_value=response)
        self.fetch_keys = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch("auth.enforce_behavior_admission", new=AsyncMock())
        self.behavior_admission = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch("request_admission.record_behavior_failure", new=AsyncMock())
        patcher.start()
        self.addCleanup(patcher.stop)

    def token(self, **changes):
        claims = {"iss": self.issuer, "aud": "inout-frontend", "sub": "alice",
                  "typ": "Bearer", "exp": int(time.time()) + 300, **changes}
        return jwt.encode(claims, self.signer, algorithm="RS256", headers={"kid": "gateway-test"})

    async def callback(self, token=None, secret=None, headers=None):
        if headers is None:
            headers = {"Authorization": "Bearer " + (token or self.token()),
                       "X-Inout-Gateway-Secret": self.secret if secret is None else secret}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://api.test") as client:
            return await client.post("/internal/gateway/identity", headers=headers)

    async def test_verified_subject_is_stable_across_token_refresh_and_ignores_hints(self):
        for issued in (1, 2):
            token = self.token(iat=int(time.time()), jti=f"refresh-{issued}")
            response = await self.callback(headers={"Authorization": "Bearer " + token,
                "X-Inout-Gateway-Secret": self.secret, "X-Inout-Rate-Identity": "forged",
                "X-Consumer-ID": "other-account", "X-Inout-Terminal-DN": "CN=forged"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"identity": "principal:" + self.issuer + ":alice",
                                             "expires_at": jwt.decode(token, options={"verify_signature": False})["exp"]})
            self.assertNotIn(token, response.text)
            self.assertNotIn(self.secret, response.text)
        self.fetch_keys.assert_called_once()
        self.behavior_admission.assert_not_awaited()

    async def test_missing_wrong_short_or_duplicate_secret_is_rejected_before_verification(self):
        headers = {"Authorization": "Bearer " + self.token()}
        for case in (headers, {**headers, "X-Inout-Gateway-Secret": "wrong"},
                [(b"Authorization", headers["Authorization"].encode()),
                 (b"X-Inout-Gateway-Secret", b"caf\xe9")],
                list(headers.items()) + [("X-Inout-Gateway-Secret", self.secret),
                                        ("X-Inout-Gateway-Secret", self.secret)]):
            with self.subTest(headers=type(case).__name__):
                self.assertEqual((await self.callback(headers=case)).status_code, 403)
        with patch.object(auth.settings, "KONG_IDENTITY_SECRET", "short"):
            self.assertEqual((await self.callback()).status_code, 403)
        self.fetch_keys.assert_not_called()

    async def test_bearer_is_mandatory_single_and_bounded(self):
        cases = ({"X-Inout-Gateway-Secret": self.secret},
                 {"X-Inout-Gateway-Secret": self.secret, "Authorization": "Basic invalid"},
                 {"X-Inout-Gateway-Secret": self.secret, "Authorization": "Bearer " + "x" * 16384},
                 [("X-Inout-Gateway-Secret", self.secret), ("Authorization", "Bearer " + self.token()),
                  ("Authorization", "Bearer " + self.token(sub="bob"))])
        for headers in cases:
            self.assertEqual((await self.callback(headers=headers)).status_code, 401)
        self.fetch_keys.assert_not_called()

    async def test_invalid_signature_issuer_audience_or_expiry_cannot_set_quota_identity(self):
        cases = [self.token(iss="https://attacker.test"), self.token(aud="other-api"),
                 self.token(exp=int(time.time()) - 1), self.token(typ="ID"), self.token(sub=""),
                 self.token(exp=str(int(time.time()) + 300)), self.token(exp=True),
                 self.token(exp=float("nan")), self.token(exp=float("inf")), self.token(exp=10 ** 1000),
                 jwt.encode({"iss": self.issuer, "aud": "inout-frontend", "sub": "forged",
                    "typ": "Bearer", "exp": int(time.time()) + 300}, "isolated-forged-key-at-least-32-characters", algorithm="HS256",
                    headers={"kid": "gateway-test"})]
        for token in cases:
            with self.subTest(token_type=jwt.get_unverified_header(token)["alg"]):
                self.assertEqual((await self.callback(token)).status_code, 401)

    async def test_authentication_outage_fails_closed(self):
        self.fetch_keys.side_effect = httpx.ConnectError("isolated offline fixture")
        self.assertEqual((await self.callback()).status_code, 503)

    async def test_callback_does_not_grant_an_application_role(self):
        # Valid realm users may be identified for accounting, but the real
        # dashboard request still independently requires the admin realm role.
        token = self.token(realm_access={"roles": ["operator"]})
        self.assertEqual((await self.callback(token)).status_code, 200)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://api.test") as client:
            response = await client.get("/v1/dashboard", headers={"Authorization": "Bearer " + token})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("/internal/gateway/identity", app.openapi()["paths"])


if __name__ == "__main__":
    unittest.main()
