"""Resource admission retains size guards without app request-frequency quotas."""
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from auth import verify_authenticated_request, verify_terminal_access_request
from config import settings
from main import verify_mtls_terminal
from request_admission import RequestAdmissionMiddleware


def protected_app():
    app = FastAPI()
    app.add_middleware(RequestAdmissionMiddleware)

    @app.post("/protected", dependencies=[Depends(verify_authenticated_request)])
    async def protected(actor=Depends(verify_terminal_access_request)):
        return {"actor": actor["sub"]}

    @app.get("/protected", dependencies=[Depends(verify_authenticated_request)])
    async def protected_read():
        return {"ok": True}

    @app.post("/terminal")
    async def terminal(identity=Depends(verify_mtls_terminal)):
        return {"terminal": identity}

    @app.post("/echo")
    async def echo(request: Request):
        return {"size": len(await request.body())}

    return app


class RequestAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for patcher in [patch.object(settings, "KONG_TERMINAL_SECRET", "verified-gateway-secret" * 2),
                        patch("auth.enforce_behavior_admission", new=AsyncMock()),
                        patch("main.enforce_behavior_admission", new=AsyncMock()),
                        patch("auth.verify_keycloak_token", side_effect=self.claims)]:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.clients = []
        for peer in ("172.18.0.9", "172.18.0.10"):
            client = httpx.AsyncClient(transport=httpx.ASGITransport(protected_app(),
                client=(peer, 1234)), base_url="http://isolated")
            self.clients.append(client)
            self.addAsyncCleanup(client.aclose)

    @staticmethod
    def claims(token, **kwargs):
        if token not in {"alice", "bob"}:
            raise HTTPException(401, "Invalid token")
        return {"sub": token, "exp": time.time() + 300,
                "realm_access": {"roles": ["operator"]}}

    async def test_successful_and_anonymous_requests_have_no_app_frequency_counter(self):
        # More than the removed 300/minute middleware cap, across two instances.
        for index in range(320):
            client = self.clients[index % 2]
            missing = await client.post("/missing", json={})
            successful = await client.post("/echo", content=b"abc")
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(successful.status_code, 200)
            self.assertEqual(successful.json(), {"size": 3})

    async def test_verified_account_and_terminal_request_frequency_is_not_counted(self):
        for index in range(320):
            client = self.clients[index % 2]
            account = await client.post("/protected", json={},
                headers={"Authorization": "Bearer alice"})
            terminal = await client.post("/terminal", json={}, headers={
                "X-Inout-Terminal-DN": "CN=terminal-one",
                "X-Inout-Gateway-Secret": settings.KONG_TERMINAL_SECRET})
            self.assertEqual(account.status_code, 200)
            self.assertEqual(terminal.status_code, 200)

    async def test_invalid_authentication_retains_401_without_backend_work_counter(self):
        for index in range(320):
            response = await self.clients[index % 2].get("/protected",
                headers={"Authorization": "Bearer forged-" + str(index)})
            self.assertEqual(response.status_code, 401)
        valid = await self.clients[0].get("/protected",
            headers={"Authorization": "Bearer alice"})
        self.assertEqual(valid.status_code, 200)

    async def test_chunked_body_still_rejects_oversize_and_delivers_complete_payload(self):
        async def chunks():
            yield b"a" * 700
            yield b"b" * 700
        with patch.object(settings, "MAX_REQUEST_BODY_BYTES", 1024):
            self.assertEqual((await self.clients[0].post("/echo", content=chunks())).status_code, 413)
            response = await self.clients[0].post("/echo", content=b"abc")
            self.assertEqual(response.json(), {"size": 3})


if __name__ == "__main__":
    unittest.main()
