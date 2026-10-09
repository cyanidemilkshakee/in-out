"""Selected step-up windows are signed, short-lived and bound to one bearer token."""
import base64
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from config import settings
from routers import keycloak_admin
from user_management_step_up import require_user_management_step_up, STEP_UP_PROOF_DOMAIN

NOW = 1_800_000_000
TOKEN = "test-only-access-token"
SECRET = "test-only-step-up-signing-secret-✓"


def base64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def proof_for(payload, *, secret=SECRET, raw=None):
    encoded = base64url(raw if raw is not None else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = hmac.new(secret.encode("utf-8"), (STEP_UP_PROOF_DOMAIN + encoded).encode("ascii"), hashlib.sha256).digest()
    return encoded + "." + base64url(signature)


def payload_for(*, duration=5, auth_time=NOW - 1, issued_at=NOW, token=TOKEN, **changes):
    return {"issuedAt": issued_at, "authTime": auth_time, "expiresAt": auth_time + duration * 60,
        "durationMinutes": duration, "tokenHash": hashlib.sha256(token.encode("utf-8")).hexdigest(), **changes}


class StepUpSettingsFixture:
    def setUp(self):
        secret = patch.object(settings, "KEYCLOAK_STEP_UP_SIGNING_SECRET", SECRET)
        age = patch.object(settings, "KEYCLOAK_STEP_UP_MAX_AGE_SECONDS", 300)
        secret.start()
        age.start()
        self.addCleanup(secret.stop)
        self.addCleanup(age.stop)


class UserManagementStepUpTests(StepUpSettingsFixture, unittest.TestCase):
    def assert_rejected(self, proof, claims=None, *, token=TOKEN, now=NOW):
        with self.assertRaises(HTTPException) as error:
            require_user_management_step_up(token, {"auth_time": NOW - 1} if claims is None else claims, proof, now=now)
        self.assertEqual(error.exception.status_code, 401)

    def test_all_six_signed_durations_remain_valid_until_their_original_login_window_ends(self):
        for duration in (5, 10, 15, 20, 30, 60):
            with self.subTest(duration=duration):
                auth_time = NOW - duration * 60 + 1
                proof = proof_for(payload_for(duration=duration, auth_time=auth_time))
                self.assertIsNone(require_user_management_step_up(TOKEN, {"auth_time": auth_time}, proof, now=NOW))
                self.assert_rejected(proof, {"auth_time": auth_time}, now=NOW + 1)

    def test_exact_expiry_boundary_and_refresh_do_not_extend_the_selected_window(self):
        payload = payload_for(duration=20, auth_time=NOW - 1200)
        proof = proof_for(payload)
        self.assertIsNone(require_user_management_step_up(TOKEN, {}, proof, now=NOW - 0.001))
        self.assert_rejected(proof, {}, now=NOW)
        self.assert_rejected(proof, {}, now=NOW + 0.001)
        # A new proof for a refreshed access token still has the original login
        # authTime and expiresAt, so it cannot restart the selected duration.
        renewed = proof_for({**payload, "issuedAt": NOW, "tokenHash": hashlib.sha256(b"refreshed-token").hexdigest()})
        self.assert_rejected(renewed, {}, token="refreshed-token")
        extended = proof_for({**payload, "expiresAt": NOW + 1200})
        self.assertIsNone(require_user_management_step_up(TOKEN, {}, extended, now=NOW))
        self.assert_rejected(extended, {}, now=NOW + 1200)

    def test_proof_signature_and_exact_bearer_token_binding_are_required(self):
        payload = payload_for()
        proof = proof_for(payload)
        encoded, signature = proof.split(".")
        tampered = proof_for({**payload, "durationMinutes": 60, "expiresAt": payload["authTime"] + 3600}).split(".")[0]
        for invalid in (tampered + "." + signature, encoded + "." + base64url(b"wrong-signature"),
                        proof_for(payload, secret="different-secret"), proof_for(payload_for(token="another-token")),
                        proof_for({**payload, "tokenHash": payload["tokenHash"].upper()})):
            with self.subTest(proof=invalid):
                self.assert_rejected(invalid)
        self.assert_rejected(proof, token=" " + TOKEN)

    def test_invalid_provided_proof_never_uses_the_fresh_direct_bearer_fallback(self):
        self.assertIsNone(require_user_management_step_up(TOKEN, {"auth_time": NOW}, None, now=NOW))
        for malformed in ("", "no-dot", "a.b.c", ".", "*.!", "x" * 2049, 42):
            with self.subTest(proof=malformed):
                self.assert_rejected(malformed)
        encoded, signature = proof_for(payload_for()).split(".")
        for malformed in (encoded + "=." + signature, encoded + "." + signature + "=",
                          encoded + ". " + signature, encoded + "." + signature + "\n"):
            with self.subTest(proof=malformed):
                self.assert_rejected(malformed)

    def test_missing_signing_secret_rejects_proof_but_keeps_fixed_direct_bearer_policy(self):
        with patch.object(settings, "KEYCLOAK_STEP_UP_SIGNING_SECRET", ""):
            self.assert_rejected(proof_for(payload_for()))
            self.assertIsNone(require_user_management_step_up(TOKEN, {"auth_time": NOW}, now=NOW))
            self.assert_rejected(None, {"auth_time": NOW - 301})

    def test_payload_requires_exact_fields_valid_json_and_no_duplicate_fields(self):
        payload = payload_for()
        missing = dict(payload)
        missing.pop("issuedAt")
        duplicate = json.dumps(payload, separators=(",", ":"))[:-1] + ',"authTime":' + str(payload["authTime"]) + "}"
        for invalid in (proof_for(missing), proof_for({**payload, "sub": "admin"}),
                        proof_for(None), proof_for([]), proof_for("payload"), proof_for({}, raw=b"not-json"),
                        proof_for({}, raw=b"\xff"), proof_for({}, raw=duplicate.encode("utf-8")),
                        proof_for({**payload, "issuedAt": float("nan")})):
            with self.subTest(proof=invalid):
                self.assert_rejected(invalid)

    def test_numeric_fields_are_strict_integers_and_only_the_six_durations_are_allowed(self):
        payload = payload_for()
        for field in ("issuedAt", "authTime", "expiresAt", "durationMinutes"):
            for invalid in (True, False, str(payload[field]), float(payload[field]), None, [], {}):
                with self.subTest(field=field, value=invalid):
                    self.assert_rejected(proof_for({**payload, field: invalid}))
        for duration in (0, -5, 1, 6, 45, 61, 300):
            with self.subTest(duration=duration):
                self.assert_rejected(proof_for(payload_for(duration=duration)))
        for token_hash in (True, None, [], "a" * 63, "g" * 64):
            with self.subTest(token_hash=token_hash):
                self.assert_rejected(proof_for({**payload, "tokenHash": token_hash}))

    def test_issued_at_and_auth_time_clock_skew_limits_have_exact_boundaries(self):
        for issued_at in (NOW - 60, NOW + 30):
            self.assertIsNone(require_user_management_step_up(TOKEN, {}, proof_for(payload_for(issued_at=issued_at)), now=NOW))
        for issued_at in (NOW - 61, NOW + 31, -(10**1000), 10**1000):
            self.assert_rejected(proof_for(payload_for(issued_at=issued_at)), {})
        self.assertIsNone(require_user_management_step_up(TOKEN, {}, proof_for(payload_for(auth_time=NOW + 30)), now=NOW))
        self.assert_rejected(proof_for(payload_for(auth_time=NOW + 31)), {})
        self.assert_rejected(proof_for(payload_for(auth_time=10**1000)), {})

    def test_optional_access_token_auth_time_must_match_verified_login_without_coercion(self):
        auth_time = NOW - 1
        proof = proof_for(payload_for(auth_time=auth_time))
        self.assertIsNone(require_user_management_step_up(TOKEN, {}, proof, now=NOW))
        self.assertIsNone(require_user_management_step_up(TOKEN, {"auth_time": float(auth_time)}, proof, now=NOW))
        for invalid in (None, True, False, str(auth_time), auth_time - 1, auth_time + 0.5,
                        float("nan"), float("inf"), -(10**1000), 10**1000):
            with self.subTest(auth_time=invalid):
                self.assert_rejected(proof, {"auth_time": invalid})

    def test_absent_header_preserves_five_minute_direct_bearer_limits_and_rejects_bad_claims(self):
        for auth_time in (NOW, NOW - 300, NOW + 30, NOW - 0.5):
            self.assertIsNone(require_user_management_step_up(TOKEN, {"auth_time": auth_time}, now=NOW))
        for invalid in (None, True, False, str(NOW), NOW - 300.001, NOW + 30.001,
                        float("nan"), float("inf"), -(10**1000), 10**1000):
            with self.subTest(auth_time=invalid):
                self.assert_rejected(None, {"auth_time": invalid})
        self.assert_rejected(None, {})


class UserManagementStepUpDependencyTests(StepUpSettingsFixture, unittest.IsolatedAsyncioTestCase):
    async def test_direct_dependency_call_defaults_to_no_header_and_still_requires_admin_bearer(self):
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=TOKEN)
        with patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(return_value={"auth_time": NOW})) as verify, \
             patch("routers.keycloak_admin.time.time", return_value=NOW):
            self.assertEqual(await keycloak_admin._admin_context(credentials), TOKEN)
            verify.assert_awaited_once_with(credentials)
        with patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock()) as verify:
            with self.assertRaises(HTTPException) as error:
                await keycloak_admin._admin_context(None, proof_for(payload_for()))
            self.assertEqual(error.exception.status_code, 401)
            verify.assert_not_awaited()
        with patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(side_effect=HTTPException(403, "Admin required"))):
            with self.assertRaises(HTTPException) as error:
                await keycloak_admin._admin_context(credentials, proof_for(payload_for()))
            self.assertEqual(error.exception.status_code, 403)

    async def test_http_header_uses_signed_duration_and_never_falls_back_on_invalid_proof(self):
        app = FastAPI()
        @app.get("/protected")
        async def protected(_token=Depends(keycloak_admin._admin_context)):
            return {"accepted": True}
        payload = payload_for(duration=60, auth_time=NOW - 3599)
        with patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(return_value={"auth_time": payload["authTime"]})), \
             patch("routers.keycloak_admin.time.time", return_value=NOW):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                headers = {"Authorization": "Bearer " + TOKEN, "X-InOut-Step-Up": proof_for(payload)}
                self.assertEqual((await client.get("/protected", headers=headers)).status_code, 200)
                self.assertEqual((await client.get("/protected", headers={"Authorization": "Bearer " + TOKEN})).status_code, 401)
                self.assertEqual((await client.get("/protected", headers={**headers, "X-InOut-Step-Up": "invalid"})).status_code, 401)
                with patch("routers.keycloak_admin.time.time", return_value=NOW + 1):
                    self.assertEqual((await client.get("/protected", headers=headers)).status_code, 401)


if __name__ == "__main__":
    unittest.main()
