"""Redis-backed application revocation for already-issued Keycloak tokens."""
import hashlib
import logging
import math
import time

from fastapi import HTTPException

from redis_client import get_redis_pool

logger = logging.getLogger(__name__)
REVOCATION_PREFIX = "inout:auth:revocation:"
PRINCIPAL_REVOCATION_TTL_SECONDS = 24 * 60 * 60


def _principal_key(issuer: str, subject: str) -> str:
    digest = hashlib.sha256((issuer + ":" + subject).encode("utf-8")).hexdigest()
    return REVOCATION_PREFIX + "principal:" + digest


def _token_key(issuer: str, subject: str, token_id: str) -> str:
    digest = hashlib.sha256((issuer + ":" + subject + ":" + token_id).encode("utf-8")).hexdigest()
    return REVOCATION_PREFIX + "token:" + digest


async def assert_token_active(claims: dict) -> None:
    """Reject a revoked token or one issued before the principal cutoff."""
    subject, token_id = claims.get("sub"), claims.get("jti")
    issued_at, expiry = claims.get("iat"), claims.get("exp")
    if (not isinstance(subject, str) or not subject or not isinstance(token_id, str) or not token_id
            or isinstance(issued_at, bool) or not isinstance(issued_at, (int, float))
            or not math.isfinite(issued_at) or isinstance(expiry, bool)
            or not isinstance(expiry, (int, float)) or not math.isfinite(expiry)):
        raise HTTPException(401, "Invalid token", headers={"WWW-Authenticate": "Bearer"})
    from config import settings
    try:
        cutoff, revoked = await get_redis_pool().mget(
            _principal_key(settings.KEYCLOAK_ISSUER, subject),
            _token_key(settings.KEYCLOAK_ISSUER, subject, token_id),
        )
    except Exception as error:
        logger.error("Token revocation store unavailable", extra={"exception_type": type(error).__name__})
        raise HTTPException(503, "Authentication service unavailable", headers={"Retry-After": "5"}) from error
    if revoked or (cutoff is not None and float(issued_at) <= float(cutoff)):
        raise HTTPException(401, "Token has been revoked", headers={"WWW-Authenticate": "Bearer"})


async def revoke_token(issuer: str, subject: str, token_id: str, expiry: float) -> None:
    remaining = max(1, math.ceil(expiry - time.time()))
    try:
        await get_redis_pool().set(_token_key(issuer, subject, token_id), "1", ex=remaining)
    except Exception as error:
        logger.error("Token revocation could not be recorded", extra={"exception_type": type(error).__name__})
        raise HTTPException(503, "Authentication service unavailable", headers={"Retry-After": "5"}) from error


async def revoke_principal_tokens(issuer: str, subject: str) -> None:
    try:
        await get_redis_pool().set(_principal_key(issuer, subject), repr(time.time()),
                                   ex=PRINCIPAL_REVOCATION_TTL_SECONDS)
    except Exception as error:
        logger.error("Account token revocation could not be recorded", extra={"exception_type": type(error).__name__})
        raise HTTPException(503, "Authentication service unavailable", headers={"Retry-After": "5"}) from error
