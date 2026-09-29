"""
Keycloak JWT authentication for the FastAPI backend.

Verifies Bearer tokens signed by the configured Keycloak realm.
Signing keys expire from the cache and refresh on an unfamiliar key ID.
Refresh requests are rate limited so arbitrary key IDs cannot flood Keycloak.
"""

import logging
import threading
import time
from typing import Any

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt
from jose.exceptions import JWKError
from starlette.concurrency import run_in_threadpool

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JWKS cache shared by the request worker threads in this process.
# ---------------------------------------------------------------------------
_jwks_cache: list[dict] | None = None
_jwks_loaded_at = 0.0
_jwks_last_attempt = float("-inf")
_JWKS_MIN_REFRESH_INTERVAL = 30
_jwks_lock = threading.Lock()


def _load_jwks(kid: str) -> list[dict]:
    """Refresh expired keys or an unknown kid, at most once per 30 seconds."""
    global _jwks_cache, _jwks_loaded_at, _jwks_last_attempt
    with _jwks_lock:
        now = time.monotonic()
        fresh = _jwks_cache is not None and now - _jwks_loaded_at < settings.KEYCLOAK_JWKS_CACHE_TTL
        if fresh and any(key.get("kid") == kid for key in _jwks_cache):
            return _jwks_cache
        if now - _jwks_last_attempt < _JWKS_MIN_REFRESH_INTERVAL:
            if fresh:
                return _jwks_cache
            raise HTTPException(status_code=503, detail="Authentication service unavailable")
        _jwks_last_attempt = now
        base = (settings.KEYCLOAK_JWKS_BASE or settings.KEYCLOAK_ISSUER).rstrip("/")
        jwks_url = f"{base}/protocol/openid-connect/certs"
        logger.info("Fetching JWKS from %s", jwks_url)
        try:
            resp = httpx.get(jwks_url, timeout=10)
            resp.raise_for_status()
            keys = resp.json()["keys"]
            if not isinstance(keys, list) or not keys or not all(isinstance(key, dict) for key in keys):
                raise ValueError("Invalid JWKS response")
            _jwks_cache = keys
            _jwks_loaded_at = time.monotonic()
            logger.info("Loaded %d JWKS key(s)", len(_jwks_cache))
            return _jwks_cache
        except Exception as exc:
            logger.error("Failed to fetch JWKS: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="Authentication service unavailable — could not fetch JWKS",
            ) from exc


# ---------------------------------------------------------------------------
# Token verification
# ---------------------------------------------------------------------------

def verify_keycloak_token(token: str) -> dict[str, Any]:
    """
    Decode and verify a Keycloak-issued JWT.

    Raises HTTPException 401 on any validation failure so FastAPI can return
    the correct HTTP response automatically.
    """
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not kid:
            raise JWTError("An RS256 signing key ID is required")
        keys = [key for key in _load_jwks(kid)
                if key.get("kid") == kid and key.get("kty") == "RSA"
                and key.get("use", "sig") == "sig" and key.get("alg", "RS256") == "RS256"]
        if not keys:
            raise JWTError("Unknown signing key")
        payload = jwt.decode(
            token,
            {"keys": keys},
            algorithms=["RS256"],
            issuer=settings.KEYCLOAK_ISSUER,
            audience=settings.KEYCLOAK_AUDIENCE,
            options={"require_exp": True, "require_iss": True, "require_aud": True, "require_sub": True},
        )
        # ID tokens are intended for the OIDC client, never for API access.
        if payload.get("typ") != "Bearer" or not payload.get("sub"):
            raise JWTError("A Keycloak access token is required")
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired", headers={"WWW-Authenticate": "Bearer"})
    except (JWTError, JWKError) as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token", headers={"WWW-Authenticate": "Bearer"})


def _realm_roles(payload: dict[str, Any]) -> list[str]:
    access = payload.get("realm_access")
    roles = access.get("roles") if isinstance(access, dict) else None
    return [role for role in roles if isinstance(role, str)] if isinstance(roles, list) else []


def has_admin_role(payload: dict[str, Any]) -> bool:
    """Return True if the token carries the 'admin' realm role."""
    return "admin" in _realm_roles(payload)


def has_operator_role(payload: dict[str, Any]) -> bool:
    """Return True when the token carries the terminal operator realm role."""
    return "operator" in _realm_roles(payload)


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

_bearer = HTTPBearer(auto_error=False)


async def verify_authenticated_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Validate an access token without selecting an application role."""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required", headers={"WWW-Authenticate": "Bearer"})
    # Network I/O and RSA verification must not block FastAPI's event loop.
    return await run_in_threadpool(verify_keycloak_token, credentials.credentials)


async def verify_admin_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """
    FastAPI dependency — validates the Keycloak Bearer token and enforces
    the 'admin' realm role.

    Authentication is mandatory in every environment.
    """
    payload = await verify_authenticated_request(credentials)

    if not has_admin_role(payload):
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions — 'admin' realm role required",
        )

    return payload


async def verify_terminal_operator_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Require the operator role; administrators are deliberately excluded."""
    payload = await verify_authenticated_request(credentials)
    if has_admin_role(payload) or not has_operator_role(payload):
        raise HTTPException(status_code=403, detail="Terminal access requires the operator realm role")
    return payload


async def verify_admin_or_operator_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Allow the one terminal workflow that creates a temporary visitor."""
    payload = await verify_authenticated_request(credentials)
    if not has_admin_role(payload) and not has_operator_role(payload):
        raise HTTPException(status_code=403, detail="An application role is required")
    return payload
