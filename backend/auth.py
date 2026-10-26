"""
Keycloak JWT authentication for the FastAPI backend.

Verifies Bearer tokens signed by the configured Keycloak realm.
Signing keys expire from the cache and refresh on an unfamiliar key ID.
Refresh requests are rate limited so arbitrary key IDs cannot flood Keycloak.
"""

import asyncio
import logging
import math
import secrets
import threading
import time
from typing import Any

import httpx
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError
from starlette.concurrency import run_in_threadpool

from config import settings
from behavior_limits import enforce_behavior_admission

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JWKS cache shared by the request worker threads in this process.
# ---------------------------------------------------------------------------
_jwks_cache: list[dict] | None = None
_jwks_loaded_at = 0.0
_jwks_last_attempt = float("-inf")
_JWKS_MIN_REFRESH_INTERVAL = 30
_jwks_lock = threading.Lock()
_jwks_snapshot = None
_jwks_refresh_task: asyncio.Task | None = None


def _fresh_jwks():
    """Read the atomically published key snapshot without taking the mutex."""
    snapshot = _jwks_snapshot
    cached, loaded_at = snapshot if snapshot is not None else (None, 0)
    if (cached is _jwks_cache and loaded_at == _jwks_loaded_at
            and cached is not None and time.monotonic() - loaded_at < settings.KEYCLOAK_JWKS_CACHE_TTL):
        return cached
    return None


async def _prepare_jwks(token: str) -> list[dict] | None:
    """Join one refresh without tying up a verifier thread per waiting request."""
    global _jwks_refresh_task
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not kid:
            return  # The normal verifier returns the standard 401 response.
    except jwt.PyJWTError:
        return

    cached = _fresh_jwks()
    if cached is not None and any(key.get("kid") == kid for key in cached):
        return cached
    loop = asyncio.get_running_loop()
    refresh = _jwks_refresh_task
    if refresh is None or refresh.get_loop() is not loop or refresh.done():
        # Task creation happens before yielding, so every concurrent request in
        # this worker joins the same bounded network fetch.
        refresh = loop.create_task(run_in_threadpool(_load_jwks, kid))
        # A disconnected waiter must not cancel a refresh used by other calls.
        # Consume its result even if every waiter disconnects before completion.
        refresh.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        _jwks_refresh_task = refresh
    try:
        return await asyncio.wait_for(asyncio.shield(refresh), timeout=12)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from exc


def _load_jwks(kid: str) -> list[dict]:
    """Refresh expired keys or an unknown kid, at most once per 30 seconds."""
    global _jwks_cache, _jwks_loaded_at, _jwks_last_attempt, _jwks_snapshot
    # The cache is replaced atomically, never mutated. A fresh known key need
    # not queue behind another caller's network refresh under the mutex.
    cached = _fresh_jwks()
    fresh_snapshot = cached is not None
    if fresh_snapshot:
        if any(key.get("kid") == kid for key in cached):
            return cached
    # Never park verification worker threads behind network I/O. Unknown keys
    # fail against fresh keys while another caller refreshes; expired keys are
    # never accepted while waiting for a refresh or during an outage.
    if not _jwks_lock.acquire(blocking=False):
        if fresh_snapshot:
            return cached
        raise HTTPException(status_code=503, detail="Authentication service unavailable")
    try:
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
            _jwks_snapshot = (_jwks_cache, _jwks_loaded_at)
            logger.info("Loaded %d JWKS key(s)", len(_jwks_cache))
            return _jwks_cache
        except Exception as exc:
            logger.error("Failed to fetch JWKS: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="Authentication service unavailable — could not fetch JWKS",
            ) from exc
    finally:
        _jwks_lock.release()


# ---------------------------------------------------------------------------
# Token verification
# ---------------------------------------------------------------------------

def verify_keycloak_token(token: str, signing_keys: list[dict] | None = None) -> dict[str, Any]:
    """
    Decode and verify a Keycloak-issued JWT.

    Raises HTTPException 401 on any validation failure so FastAPI can return
    the correct HTTP response automatically.
    """
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not kid:
            raise InvalidTokenError("An RS256 signing key ID is required")
        keys = [key for key in (signing_keys if signing_keys is not None else _load_jwks(kid))
                if key.get("kid") == kid and key.get("kty") == "RSA"
                and key.get("use", "sig") == "sig" and key.get("alg", "RS256") == "RS256"]
        if not keys:
            raise InvalidTokenError("Unknown signing key")
        signing_key = jwt.PyJWK.from_dict(keys[0], algorithm="RS256").key
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=settings.KEYCLOAK_ISSUER,
            audience=settings.KEYCLOAK_AUDIENCE,
            options={"require": ["exp", "iat", "iss", "aud", "sub", "jti"]},
        )
        # ID tokens are intended for the OIDC client, never for API access.
        if payload.get("typ") != "Bearer" or not isinstance(payload.get("sub"), str) or not payload["sub"]:
            raise InvalidTokenError("A Keycloak access token is required")
        expiry = payload["exp"]
        issued_at = payload["iat"]
        if (isinstance(expiry, bool) or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry) or isinstance(issued_at, bool)
                or not isinstance(issued_at, (int, float)) or not math.isfinite(issued_at)
                or not isinstance(payload.get("jti"), str) or not payload["jti"]):
            raise InvalidTokenError("Numeric token expiry, issue time and token ID are required")
        payload["_inout_verified_access_token"] = True
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired", headers={"WWW-Authenticate": "Bearer"})
    except (InvalidTokenError, jwt.PyJWTError, ValueError, TypeError, OverflowError) as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token", headers={"WWW-Authenticate": "Bearer"})


def _realm_roles(payload: dict[str, Any]) -> list[str]:
    access = payload.get("realm_access")
    roles = access.get("roles") if isinstance(access, dict) else None
    return [role for role in roles if isinstance(role, str)] if isinstance(roles, list) else []


def has_admin_role(payload: dict[str, Any]) -> bool:
    """Return True if the token carries the application's admin realm role."""
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
    request: Request = None,
) -> dict[str, Any]:
    """Validate an access token without selecting an application role."""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required", headers={"WWW-Authenticate": "Bearer"})
    signing_keys = await _prepare_jwks(credentials.credentials)
    # Network I/O and RSA verification must not block FastAPI's event loop.
    # Use the keys selected while admitting this request. A second cache lookup
    # could cross the TTL boundary while queued for a verifier thread and race
    # a refresh again. Malformed headers still use the standard 401 verifier.
    payload = await run_in_threadpool(verify_keycloak_token, credentials.credentials,
                                     **({"signing_keys": signing_keys} if signing_keys is not None else {}))
    cryptographically_verified = payload.pop("_inout_verified_access_token", False)
    if cryptographically_verified:
        from token_revocation import assert_token_active
        await assert_token_active(payload)
    if request is not None:
        identity = "principal:" + settings.KEYCLOAK_ISSUER + ":" + payload["sub"]
        state = request.scope.setdefault("state", {})
        state["limit_identity"] = identity
        state["limit_actor"] = payload["sub"]
        await enforce_behavior_admission(request, identity)
    return payload


async def verify_gateway_rate_identity(request: Request) -> dict[str, Any]:
    """Return only a verified subject and expiry to the private Kong callback.

    This is authentication for quota accounting, never application role or
    step-up authorization. The real API request still validates those rules.
    Kong blocks the entire /internal root on every external listener.
    """
    secret = settings.KONG_IDENTITY_SECRET
    provided = request.headers.getlist("X-Inout-Gateway-Secret")
    if (len(secret) < 32 or len(provided) != 1
            or not secrets.compare_digest(provided[0].encode("utf-8"), secret.encode("utf-8"))):
        raise HTTPException(status_code=403, detail="Trusted Kong identity callback required")
    authorizations = request.headers.getlist("Authorization")
    if len(authorizations) != 1 or len(authorizations[0]) > 16_384:
        raise HTTPException(status_code=401, detail="Bearer token required", headers={"WWW-Authenticate": "Bearer"})
    credentials = await _bearer(request)
    # Avoid behavior/data accounting for this internal verification request.
    payload = await verify_authenticated_request(credentials, request=None)
    expiry = payload["exp"]
    if (isinstance(expiry, bool) or not isinstance(expiry, (int, float))
            or not math.isfinite(expiry) or expiry <= time.time()):
        raise HTTPException(status_code=401, detail="Invalid token expiry", headers={"WWW-Authenticate": "Bearer"})
    return {"identity": "principal:" + settings.KEYCLOAK_ISSUER + ":" + payload["sub"],
            "expires_at": expiry}


async def verify_admin_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    request: Request = None,
) -> dict[str, Any]:
    """
    FastAPI dependency — validates the Keycloak Bearer token and enforces
    the 'admin' realm role.

    Authentication is mandatory in every environment.
    """
    payload = await verify_authenticated_request(credentials, request)

    if not has_admin_role(payload):
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions — an administrator realm role is required",
        )

    return payload


async def verify_terminal_access_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    request: Request = None,
) -> dict[str, Any]:
    """Allow administrators and terminal operators to use terminal routes."""
    payload = await verify_authenticated_request(credentials, request)
    if not has_admin_role(payload) and not has_operator_role(payload):
        raise HTTPException(status_code=403, detail="Terminal access requires the admin or operator realm role")
    return payload


async def verify_admin_or_operator_request(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    request: Request = None,
) -> dict[str, Any]:
    """Allow the one terminal workflow that creates a temporary visitor."""
    payload = await verify_authenticated_request(credentials, request)
    if not has_admin_role(payload) and not has_operator_role(payload):
        raise HTTPException(status_code=403, detail="An application role is required")
    return payload
