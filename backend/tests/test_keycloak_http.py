"""Bounded identity HTTP pool and per-administrator credential isolation."""
import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import HTTPException

import keycloak_http
from routers import keycloak_admin


class KeycloakHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await keycloak_http.close_keycloak_admin_client()

    async def test_concurrent_requests_share_bounded_pool_and_shutdown_recreates_it(self):
        first = Mock(is_closed=False, aclose=AsyncMock())
        second = Mock(is_closed=False, aclose=AsyncMock())

        async def get_client():
            return keycloak_http.get_keycloak_admin_client()

        with patch.object(keycloak_http.httpx, "AsyncClient", side_effect=[first, second]) as create:
            self.assertTrue(all(client is first for client in await asyncio.gather(*[get_client() for _ in range(20)])))
            create.assert_called_once()
            options = create.call_args.kwargs
            self.assertEqual(options["timeout"], 10)
            self.assertFalse(options["follow_redirects"])
            self.assertEqual(options["limits"].max_connections, 16)
            self.assertEqual(options["limits"].max_keepalive_connections, 8)
            self.assertEqual(options["limits"].keepalive_expiry, 30)
            self.assertNotIn("headers", options)
            await keycloak_http.close_keycloak_admin_client()
            first.aclose.assert_awaited_once()
            self.assertIs(keycloak_http.get_keycloak_admin_client(), second)
            await keycloak_http.close_keycloak_admin_client()
            await keycloak_http.close_keycloak_admin_client()
            second.aclose.assert_awaited_once()

    async def test_closed_client_is_replaced(self):
        first = keycloak_http.get_keycloak_admin_client()
        await first.aclose()
        second = keycloak_http.get_keycloak_admin_client()
        self.assertIsNot(first, second)
        self.assertFalse(second.is_closed)

    async def test_bearers_payload_and_cookies_are_isolated_on_shared_transport(self):
        requests = []

        async def provider(request):
            requests.append(request)
            await asyncio.sleep(0)
            return httpx.Response(200, json={"ok": True}, headers={"Set-Cookie": "admin-session=private; Path=/"})

        create_client = httpx.AsyncClient
        with patch.object(keycloak_http.httpx, "AsyncClient", side_effect=lambda **options: create_client(
                transport=httpx.MockTransport(provider), **options)), \
             patch.object(keycloak_admin, "_keycloak_base", return_value="https://identity.invalid"), \
             patch.object(keycloak_admin, "_realm_name", return_value="inout"):
            await asyncio.gather(
                keycloak_admin._request("alice-token", "PUT", "users/alice", {"enabled": False}),
                keycloak_admin._request("bob-token", "GET", "users/bob"),
            )
            await keycloak_admin._request("carol-token", "GET", "users/carol")
            client = keycloak_http.get_keycloak_admin_client()
            self.assertEqual([request.headers["Authorization"] for request in requests],
                ["Bearer alice-token", "Bearer bob-token", "Bearer carol-token"])
            self.assertTrue(all("cookie" not in request.headers for request in requests))
            self.assertNotIn("Authorization", client.headers)
            self.assertEqual(list(client.cookies.items()), [])
            self.assertEqual(json.loads(requests[0].content), {"enabled": False})
            self.assertEqual(str(requests[0].url), "https://identity.invalid/admin/realms/inout/users/alice")

    async def test_provider_error_mapping_and_timeout_are_unchanged(self):
        for provider_status, expected_status in ((401, 401), (403, 403), (404, 404),
                (409, 409), (429, 429), (400, 400), (500, 503)):
            with self.subTest(status=provider_status):
                client = Mock(request=AsyncMock(return_value=httpx.Response(provider_status, json={"errorMessage": "Rejected"})))
                with patch.object(keycloak_admin, "get_keycloak_admin_client", return_value=client):
                    with self.assertRaises(HTTPException) as rejected:
                        await keycloak_admin._request("isolated", "GET", "users")
                self.assertEqual(rejected.exception.status_code, expected_status)
        client = Mock(request=AsyncMock(side_effect=httpx.ReadTimeout("isolated timeout")))
        with patch.object(keycloak_admin, "get_keycloak_admin_client", return_value=client):
            with self.assertRaises(HTTPException) as unavailable:
                await keycloak_admin._request("isolated", "GET", "users")
        self.assertEqual(unavailable.exception.status_code, 503)
        self.assertEqual(unavailable.exception.detail, "Identity service is unavailable")

    async def test_redirects_are_not_followed(self):
        requests = []

        def provider(request):
            requests.append(request)
            return httpx.Response(302, headers={"Location": "https://untrusted.invalid/collect"})

        create_client = httpx.AsyncClient
        with patch.object(keycloak_http.httpx, "AsyncClient", side_effect=lambda **options: create_client(
                transport=httpx.MockTransport(provider), **options)):
            response = await keycloak_admin._request("isolated", "GET", "users")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(len(requests), 1)


class KeycloakHttpLoopTests(unittest.TestCase):
    def test_separate_event_loops_never_share_transports(self):
        async def lifecycle():
            client = keycloak_http.get_keycloak_admin_client()
            await keycloak_http.close_keycloak_admin_client()
            return client

        first, second = asyncio.run(lifecycle()), asyncio.run(lifecycle())
        self.assertIsNot(first, second)
        self.assertTrue(first.is_closed)
        self.assertTrue(second.is_closed)


if __name__ == "__main__":
    unittest.main()
