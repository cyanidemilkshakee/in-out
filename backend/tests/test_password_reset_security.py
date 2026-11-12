"""Password reset invalidates sessions and already-issued application tokens."""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
import httpx
from pydantic import ValidationError
from routers import keycloak_admin


class PasswordResetSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.actor = {"sub": "master", "realm_access": {"roles": ["master-admin", "zone-admin"]}}
        self.payload = keycloak_admin.PasswordResetRequest(password="New fixture password 123!")
        self.roles = patch("routers.keycloak_admin._user_roles", new=AsyncMock(return_value=["operator"]))
        self.roles.start()
        self.addCleanup(self.roles.stop)

    async def reset(self, actor=None):
        # Call the route function with explicit dependency values; FastAPI's
        # Depends markers are only resolved when the route is invoked through ASGI.
        return await keycloak_admin.reset_password("operator", self.payload, "token", AsyncMock(),
            self.actor if actor is None else actor)

    async def test_reset_ends_provider_sessions_then_revokes_all_application_tokens(self):
        calls = []
        async def request(token, method, path, payload=None):
            calls.append((method, path))
            if method == "GET":
                return httpx.Response(200, json={"username": "operator", "enabled": True})
            return httpx.Response(204)
        async def revoke(issuer, subject):
            calls.append(("revoke", subject))
        with patch("routers.keycloak_admin._request", side_effect=request), \
             patch("routers.keycloak_admin.revoke_principal_tokens", side_effect=revoke):
            self.assertEqual(await self.reset(), {"updated": True})
        self.assertEqual(calls, [("GET", "users/operator"), ("PUT", "users/operator/reset-password"),
            ("POST", "users/operator/logout"), ("revoke", "operator")])

    async def test_logout_failure_still_revokes_existing_access_tokens_and_reports_partial_save(self):
        revoke = AsyncMock()
        async def request(token, method, path, payload=None):
            if method == "GET":
                return httpx.Response(200, json={"username": "operator", "enabled": True})
            if method == "POST":
                raise HTTPException(503, "isolated identity outage")
            return httpx.Response(204)
        with patch("routers.keycloak_admin._request", side_effect=request), \
             patch("routers.keycloak_admin.revoke_principal_tokens", new=revoke):
            with self.assertRaises(HTTPException) as raised:
                await self.reset()
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Password changed", raised.exception.detail)
        self.assertIn("sessions could not be ended", raised.exception.detail)
        revoke.assert_awaited_once()

    async def test_revocation_failure_reports_password_changed_and_never_returns_success(self):
        async def request(token, method, path, payload=None):
            if method == "GET":
                return httpx.Response(200, json={"username": "operator", "enabled": True})
            return httpx.Response(204)
        request = AsyncMock(side_effect=request)
        with patch("routers.keycloak_admin._request", new=request), \
             patch("routers.keycloak_admin.revoke_principal_tokens", side_effect=HTTPException(503, "isolated")):
            with self.assertRaises(HTTPException) as raised:
                await self.reset()
        self.assertIn("Password changed", raised.exception.detail)
        self.assertIn("could not be revoked", raised.exception.detail)
        self.assertEqual(request.await_count, 3)

    async def test_rejected_reset_does_not_end_sessions_or_publish_revocation(self):
        for status in (400, 401, 403, 404, 409, 429):
            with self.subTest(status=status):
                async def reject_reset(token, method, path, payload=None):
                    if method == "GET":
                        return httpx.Response(200, json={"username": "operator", "enabled": True})
                    raise HTTPException(status, "isolated rejection")
                request, revoke = AsyncMock(side_effect=reject_reset), AsyncMock()
                with patch("routers.keycloak_admin._request", new=request), patch("routers.keycloak_admin.revoke_principal_tokens", new=revoke):
                    with self.assertRaises(HTTPException) as raised:
                        await self.reset()
                self.assertEqual(raised.exception.status_code, status)
                self.assertEqual(request.await_count, 2)
                revoke.assert_not_awaited()

    async def test_ambiguous_reset_attempts_both_protections_once_and_reports_unconfirmed_write(self):
        for reset_failure in (HTTPException(503, "isolated provider outage"),
                              HTTPException(502, "isolated gateway outage"),
                              httpx.ReadTimeout("isolated lost response")):
            for logout_fails, revocation_fails in ((False, False), (True, False), (False, True), (True, True)):
                with self.subTest(failure=type(reset_failure).__name__, logout=logout_fails, revocation=revocation_fails):
                    calls = []
                    async def request(token, method, path, payload=None):
                        calls.append((method, path))
                        if method == "GET":
                            return httpx.Response(200, json={"username": "operator", "enabled": True})
                        if method == "PUT":
                            raise reset_failure
                        if logout_fails:
                            raise HTTPException(503, "isolated logout outage")
                        return httpx.Response(204)
                    async def revoke(issuer, subject):
                        calls.append(("revoke", subject))
                        if revocation_fails:
                            raise HTTPException(503, "isolated revocation outage")
                    with patch("routers.keycloak_admin._request", side_effect=request), \
                         patch("routers.keycloak_admin.revoke_principal_tokens", side_effect=revoke):
                        with self.assertRaises(HTTPException) as raised:
                            await self.reset()
                    self.assertEqual(raised.exception.status_code, 503)
                    self.assertIn("reset could not be confirmed", raised.exception.detail)
                    self.assertIn("Try signing in with the new password", raised.exception.detail)
                    self.assertNotIn("Password changed", raised.exception.detail)
                    if logout_fails:
                        self.assertIn("sessions could not be ended", raised.exception.detail)
                    if revocation_fails:
                        self.assertIn("tokens could not be revoked", raised.exception.detail)
                    if logout_fails or revocation_fails:
                        self.assertIn("Use End sessions", raised.exception.detail)
                    else:
                        self.assertIn("sessions and application tokens were revoked", raised.exception.detail)
                    self.assertEqual(calls, [("GET", "users/operator"), ("PUT", "users/operator/reset-password"),
                        ("POST", "users/operator/logout"), ("revoke", "operator")])

    async def test_both_outages_report_both_incomplete_protections(self):
        async def request(token, method, path, payload=None):
            if method == "GET":
                return httpx.Response(200, json={"username": "operator", "enabled": True})
            if method == "POST":
                raise HTTPException(503, "isolated")
            return httpx.Response(204)
        with patch("routers.keycloak_admin._request", side_effect=request), \
             patch("routers.keycloak_admin.revoke_principal_tokens", side_effect=HTTPException(503, "isolated")):
            with self.assertRaises(HTTPException) as raised:
                await self.reset()
        self.assertIn("sessions could not be ended", raised.exception.detail)
        self.assertIn("tokens could not be revoked", raised.exception.detail)
        self.assertIn("Use End sessions", raised.exception.detail)

    async def test_zone_admin_cannot_reset_passwords(self):
        with patch("routers.keycloak_admin._request", new=AsyncMock()) as request:
            with self.assertRaises(HTTPException) as raised:
                await self.reset({"realm_access": {"roles": ["zone-admin"]}})
        self.assertEqual(raised.exception.status_code, 403)
        request.assert_not_awaited()

    async def test_end_sessions_attempts_both_stores_and_reports_each_partial_failure(self):
        for logout_fails, revocation_fails in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(logout=logout_fails, revocation=revocation_fails):
                calls = []
                async def request(token, method, path, payload=None):
                    calls.append((method, path))
                    if logout_fails:
                        raise HTTPException(503, "isolated logout outage")
                async def revoke(issuer, subject):
                    calls.append(("revoke", subject))
                    if revocation_fails:
                        raise HTTPException(503, "isolated revocation outage")
                with patch("routers.keycloak_admin._request", side_effect=request), \
                     patch("routers.keycloak_admin.revoke_principal_tokens", side_effect=revoke):
                    if logout_fails or revocation_fails:
                        with self.assertRaises(HTTPException) as raised:
                            await keycloak_admin.end_user_sessions("operator", "token", self.actor)
                        self.assertEqual(raised.exception.status_code, 503)
                        if logout_fails:
                            self.assertIn("sessions could not be ended", raised.exception.detail)
                        if revocation_fails:
                            self.assertIn("tokens could not be revoked", raised.exception.detail)
                    else:
                        self.assertEqual(await keycloak_admin.end_user_sessions("operator", "token", self.actor), {"updated": True})
                self.assertEqual(calls, [("POST", "users/operator/logout"), ("revoke", "operator")])

    def test_password_reset_rejects_short_passwords_and_preserves_passphrase_bytes(self):
        for password in ("x", "a" * 11, " " * 12, "\t\n" * 6, "\u2003" * 12):
            with self.assertRaises(ValidationError):
                keycloak_admin.PasswordResetRequest(password=password)
        password = "  a long passphrase  "
        self.assertEqual(keycloak_admin.PasswordResetRequest(password=password).password, password)
