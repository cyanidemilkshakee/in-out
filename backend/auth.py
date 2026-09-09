"""
Keycloak JWT authentication for the FastAPI backend.

Verifies Bearer tokens signed by the configured Keycloak realm.
JWKS keys are fetched once at first use and cached for the process lifetime
(Keycloak key rotation is rare; restart the service to force a refresh).
"""

import logging
import threading
from typing import Any

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt
from jose.exceptions import JWKError

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JWKS cache — populated on first token verification, then reused.
# A threading.Lock is used because FastAPI may run startup in multiple threads.
# ---------------------------------------------------------------------------
_jwks_cache: list[dict] | None = None
_jwks_lock = threading.Lock()


def _load_jwks() -> list[dict]:
    """Fetch and cache JWKS keys from Keycloak. Thread-safe."""
    global _jwks_cache
    if _jwks_cache is not None:
        return _jwks_cache
    with _jwks_lock:
        if _jwks_cache is not None:          # double-checked locking
            return _jwks_cache
        jwks_url = f"{settings.KEYCLOAK_JWKS_BASE or settings.KEYCLOAK_ISSUER}/protocol/openid-connect/certs"
        logger.info("Fetching JWKS from %s", jwks_url)
        try:
            resp = httpx.get(jwks_url, timeout=10)
            resp.raise_for_status()
            _jwks_cache = resp.json()["keys"]
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
        keys = _load_jwks()
        # python-jose picks the correct key via the token's `kid` header claim.
        payload = jwt.decode(
            token,
            keys,
            algorithms=["RS256"],
            issuer=settings.KEYCLOAK_ISSUER,
            audience=settings.KEYCLOAK_AUDIENCE,
        )
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except (JWTError, JWKError) as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token")


def has_admin_role(payload: dict[str, Any]) -> bool:
    """Return True if the token carries the 'admin' realm role."""
    roles: list[str] = (
        payload.get("realm_access", {}).get("roles", [])
    )
    return "admin" in roles


def has_operator_role(payload: dict[str, Any]) -> bool:
    """Return True when the token carries the terminal operator realm role."""
    roles: list[str] = payload.get("realm_access", {}).get("roles", [])
    return "operator" in roles


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

_bearer = HTTPBearer(auto_error=False)


async def verify_authenticated_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Validate an access token without selecting an application role."""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    return verify_keycloak_token(credentials.credentials)


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
