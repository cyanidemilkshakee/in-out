import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from request_limits import RequestLimitsMiddleware
from routers import keycloak_admin


class RobustnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_expired_stream_closes_its_subscription(self):
        from routers.presence import _sse_event_generator
        closed = []
        async def messages():
            try:
                yield '{"subject_id":"p1"}'
            finally:
                closed.append(True)
        request = AsyncMock()
        with patch("routers.presence.subscribe_presence", messages):
            self.assertEqual([event async for event in _sse_event_generator(request, 0)], [])
        self.assertEqual(closed, [True])

    async def test_chunked_body_limits_and_payload_delivery(self):
        app = FastAPI()
        app.add_middleware(RequestLimitsMiddleware)
        @app.post("/echo")
        async def echo(request: Request):
            return {"size": len(await request.body())}
        async def oversized():
            yield b"x" * 700
            yield b"x" * 700
        with patch("request_limits.settings.MAX_REQUEST_BODY_BYTES", 1024):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                self.assertEqual((await client.post("/echo", content=oversized())).status_code, 413)
                response = await client.post("/echo", content=b"abc")
                self.assertEqual(response.json(), {"size": 3})

    async def test_keycloak_email_change_clears_verification(self):
        user = {"id": "user", "username": "alice", "email": "old@example.org", "emailVerified": True, "enabled": True}
        calls = []
        async def identity(token, method, path, payload=None):
            calls.append((method, path, payload))
            return httpx.Response(200, json=[] if path.endswith("role-mappings/realm") else user)
        with patch("routers.keycloak_admin._request", side_effect=identity):
            db = AsyncMock()
            db.get.return_value = None
            await keycloak_admin.update_user("user", keycloak_admin.UserUpdateRequest(email="new@example.org"), "token", db, {"sub": "admin"})
        self.assertFalse(next(payload for method, _, payload in calls if method == "PUT")["emailVerified"])

    async def test_password_whitespace_is_preserved_and_roles_update_only_differences(self):
        password = "  example password  "
        self.assertEqual(keycloak_admin.UserCreateRequest(username="alice", password=password).password, password)
        calls = []
        async def identity(token, method, path, payload=None):
            calls.append((method, path, payload))
            if path.startswith("roles/"):
                return httpx.Response(200, json={"id": "admin", "name": "admin"})
            return httpx.Response(200, json=[{"id": "admin", "name": "admin"}])
        with patch("routers.keycloak_admin._request", side_effect=identity):
            self.assertEqual(await keycloak_admin._replace_roles("token", "user", ["admin"]), ["admin"])
        self.assertTrue(all(method == "GET" for method, _, _ in calls))

    async def test_invalid_step_up_times_fail_closed(self):
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")
        for auth_time in (True, float("nan"), float("inf"), 10**20):
            with patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(return_value={"auth_time": auth_time})):
                with self.assertRaises(HTTPException) as error:
                    await keycloak_admin._admin_context(credentials)
                self.assertEqual(error.exception.status_code, 401)
