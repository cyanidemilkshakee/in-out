"""Verify the BFF's token-bound, signed user-management authentication window."""
import base64
import binascii
import hashlib
import hmac
import json
import math
import re
import time

from fastapi import HTTPException
from config import settings

STEP_UP_DURATION_MINUTES = frozenset({5, 10, 15, 20, 30, 60})
STEP_UP_PROOF_DOMAIN = "inout:user-management-step-up:v1."
_PROOF_FIELDS = frozenset({"issuedAt", "authTime", "expiresAt", "durationMinutes", "tokenHash", "windowId"})
_WINDOW_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_INTEGER_FIELDS = ("issuedAt", "authTime", "expiresAt", "durationMinutes")
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_TOKEN_HASH = re.compile(r"^[0-9a-f]{64}$")
_ERROR = "Step-up authentication required before managing users"


def _reject():
    raise HTTPException(status_code=401, detail=_ERROR)


def _decode_base64url(value):
    if not _BASE64URL.fullmatch(value):
        raise ValueError("Invalid base64url")
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    # Refuse alternate encodings, whitespace and padding in the wire proof.
    if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value:
        raise ValueError("Noncanonical base64url")
    return decoded


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate proof field")
        result[key] = value
    return result


def _reject_json_constant(_value):
    raise ValueError("Nonfinite JSON number")


def _numeric_auth_time(value):
    # Keep compatibility with existing direct callers that supply time.time(),
    # without allowing booleans, strings or nonfinite floating-point values.
    return type(value) is int or (type(value) is float and math.isfinite(value))


def verified_user_management_window(token, claims, proof=None, *, now=None):
    """Verify a BFF proof; a raw bearer cannot bypass a revoked app window."""
    now = time.time() if now is None else now
    if proof is None:
        _reject()

    secret = settings.KEYCLOAK_STEP_UP_SIGNING_SECRET
    if not secret or not isinstance(proof, str) or not 1 <= len(proof) <= 2048:
        _reject()
    try:
        encoded_payload, encoded_signature = proof.split(".")
        signature = _decode_base64url(encoded_signature)
        expected = hmac.new(secret.encode("utf-8"),
            (STEP_UP_PROOF_DOMAIN + encoded_payload).encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            _reject()
        payload = json.loads(_decode_base64url(encoded_payload).decode("utf-8"),
            object_pairs_hook=_unique_json_object, parse_constant=_reject_json_constant)
    except (ValueError, UnicodeError, binascii.Error, RecursionError):
        _reject()
    if not isinstance(payload, dict) or set(payload) != _PROOF_FIELDS:
        _reject()
    if not isinstance(payload["windowId"], str) or not _WINDOW_ID.fullmatch(payload["windowId"]):
        _reject()
    if any(type(payload[field]) is not int for field in _INTEGER_FIELDS):
        _reject()
    duration = payload["durationMinutes"]
    if duration not in STEP_UP_DURATION_MINUTES:
        _reject()
    issued_at, auth_time, expires_at = payload["issuedAt"], payload["authTime"], payload["expiresAt"]
    if not now - 60 <= issued_at <= now + 30 or auth_time > now + 30:
        _reject()
    # The BFF signs the resulting expiry after a fresh Keycloak login. For an
    # extension, the selected increment is added to the old expiry, so OAuth
    # latency can make that deadline earlier than auth_time + duration.
    if not now < expires_at:
        _reject()
    token_hash = payload["tokenHash"]
    if not isinstance(token_hash, str) or not _TOKEN_HASH.fullmatch(token_hash):
        _reject()
    if not hmac.compare_digest(token_hash, hashlib.sha256(token.encode("utf-8")).hexdigest()):
        _reject()
    if "auth_time" in claims:
        access_auth_time = claims["auth_time"]
        if not _numeric_auth_time(access_auth_time) or access_auth_time != auth_time:
            _reject()
    return payload
