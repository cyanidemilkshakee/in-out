"""HTTP-process connection pool for application-scoped identity administration."""
from __future__ import annotations

import asyncio
from http.cookiejar import CookieJar, DefaultCookiePolicy

import httpx

_CLIENT_ATTRIBUTE = "_inout_keycloak_admin_http_client"


class _NoIdentityCookies(DefaultCookiePolicy):
    """Administrator calls use their own bearer, never another caller's cookies."""

    def set_ok(self, cookie, request):
        return False

    def return_ok(self, cookie, request):
        return False


def get_keycloak_admin_client() -> httpx.AsyncClient:
    """Reuse a bounded pool only within its owning event loop.

    The loop owns this reference so isolated test loops cannot reuse transports
    from closed loops, and a global cache cannot retain abandoned loop objects.
    No credentials are stored in the shared client's headers or cookie jar.
    """
    loop = asyncio.get_running_loop()
    client = getattr(loop, _CLIENT_ATTRIBUTE, None)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            timeout=10,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8, keepalive_expiry=30),
            cookies=CookieJar(policy=_NoIdentityCookies()),
        )
        # Creation does not yield, so concurrent requests see the same pool.
        setattr(loop, _CLIENT_ATTRIBUTE, client)
    return client


async def close_keycloak_admin_client() -> None:
    """Close this HTTP lifespan's pool without touching another loop's client."""
    loop = asyncio.get_running_loop()
    client = getattr(loop, _CLIENT_ATTRIBUTE, None)
    if client is not None:
        delattr(loop, _CLIENT_ATTRIBUTE)
        await client.aclose()
