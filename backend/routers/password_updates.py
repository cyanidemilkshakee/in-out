"""Short, authenticated cross-replica leases for app-managed password updates."""
import asyncio
import hashlib
import hmac
import json
import re
import time
import uuid

from fastapi import APIRouter, HTTPException, Request

from config import settings
from redis_client import get_redis_pool


router = APIRouter()
_PREFIX = b"inout:password-update-lease:v1\n"
_MAX_BODY_BYTES = 1024
_LEASE_SECONDS = 90
_PROOF_MAX_AGE_SECONDS = 15
_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def _unavailable():
    return HTTPException(503, "Password update coordination is unavailable. Try again.",
                         headers={"Retry-After": "5"})


def _unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate field")
        result[key] = value
    return result


async def _verified_body(request: Request) -> dict:
    secret = settings.KEYCLOAK_STEP_UP_SIGNING_SECRET
    if len(secret) < 32:
        raise _unavailable()
    if len(request.headers.getlist("content-type")) != 1 or not re.fullmatch(
            r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*',
            request.headers.get("content-type", ""), re.IGNORECASE):
        raise HTTPException(415, "JSON content is required")
    times = request.headers.getlist("x-inout-password-lease-time")
    signatures = request.headers.getlist("x-inout-password-lease-signature")
    if (len(times) != 1 or len(signatures) != 1
            or not re.fullmatch(r"[1-9][0-9]{0,11}", times[0])
            or not re.fullmatch(r"[0-9a-f]{64}", signatures[0])
            or abs(time.time() - int(times[0])) > _PROOF_MAX_AGE_SECONDS):
        raise HTTPException(401, "Trusted password update proof required")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,12}", lengths[0])):
        raise HTTPException(400, "Invalid request length")
    if lengths and int(lengths[0]) > _MAX_BODY_BYTES:
        raise HTTPException(413, "Password update coordination request is too large")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > _MAX_BODY_BYTES:
            raise HTTPException(413, "Password update coordination request is too large")
        chunks.append(chunk)
    raw_body = b"".join(chunks)
    if lengths and int(lengths[0]) != size:
        raise HTTPException(400, "Invalid request length")
    message = _PREFIX + times[0].encode("ascii") + b"\n" + raw_body
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signatures[0]):
        raise HTTPException(401, "Trusted password update proof required")
    try:
        payload = json.loads(raw_body.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(payload, dict) or set(payload) != {"subject", "leaseId", "action"}:
            raise ValueError("Invalid fields")
        subject, lease_id, action = payload["subject"], payload["leaseId"], payload["action"]
        if (not isinstance(subject, str) or not 1 <= len(subject) <= 128
                or any(ord(char) < 32 or ord(char) == 127 for char in subject)
                or not isinstance(lease_id, str) or not isinstance(action, str)
                or action not in {"acquire", "release"}):
            raise ValueError("Invalid values")
        subject.encode("utf-8")
        parsed = uuid.UUID(lease_id)
        if parsed.version != 4 or str(parsed) != lease_id:
            raise ValueError("Invalid lease")
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(422, "Invalid password update coordination request") from None
    return payload


@router.post("/internal/password-updates/lease", include_in_schema=False)
async def password_update_lease(request: Request) -> dict:
    try:
        async with asyncio.timeout(4):
            payload = await _verified_body(request)
            key = "inout:security-limits:password-update:lease:" + hashlib.sha256(
                payload["subject"].encode("utf-8")).hexdigest()
            redis = get_redis_pool()
            if payload["action"] == "acquire":
                if not await redis.set(key, payload["leaseId"], nx=True, ex=_LEASE_SECONDS):
                    raise HTTPException(409, "A password update is already in progress. Try again.",
                                        headers={"Retry-After": "5"})
            else:
                await redis.eval(_RELEASE_SCRIPT, 1, key, payload["leaseId"])
            return {"ok": True}
    except HTTPException:
        raise
    except Exception:
        # Driver exception messages may include submitted keys or lease values.
        raise _unavailable() from None
