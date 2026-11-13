"""Invitation-gated Zoho sign-in using disabled Keycloak shadow users."""
from __future__ import annotations

import hashlib
import hmac
import asyncio
import logging
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from auth import has_master_admin_role, verify_admin_request
from config import settings
from database import get_db
from invitation_mail import ensure_invitation_mail_ready, send_invitation
from keycloak_http import get_keycloak_admin_client
from models import AuditEvent, Checkpoint, TerminalCheckpointAssignment, ZoneAdminAssignment
from terminal_assignments import enqueue_checkpoint_assignment, set_checkpoint_assignment
from event_outbox import enqueue_changed
from zone_access import admin_zone_ids, require_checkpoint_scope

from routers import keycloak_admin

router = APIRouter(prefix="/v1/invitations", tags=["invitations"])
logger = logging.getLogger(__name__)
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{40,64}$")
_PENDING = "pending"
_ACCEPTED = "accepted"
_REVOKED = "revoked"


def _normalize_invite_email(value: str) -> str:
    value = value.strip().casefold()
    if (len(value) > 254 or any(ord(char) < 33 for char in value) or
            value.count("@") != 1 or value.startswith("@") or value.endswith("@") or
            "." not in value.rsplit("@", 1)[1]):
        raise ValueError("Enter a valid email address")
    return value


class InviteCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    first_name: str = Field(min_length=1, max_length=100, alias="firstName")
    last_name: str = Field(min_length=1, max_length=100, alias="lastName")
    role: Literal["zone-admin", "operator"]
    checkpoint_id: Annotated[str | None, StringConstraints(min_length=1, max_length=64)] = Field(None, alias="checkpointId")
    zone_ids: list[str] = Field(default_factory=list, alias="zoneIds", max_length=100)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return _normalize_invite_email(value)


class InviteResendRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    email: str | None = Field(None, min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        return _normalize_invite_email(value) if value is not None else None


class PublicInviteAcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=128, alias="userId")
    token: str = Field(min_length=40, max_length=64)


def _attribute(user: dict[str, Any], name: str) -> str:
    attributes = user.get("attributes")
    value = attributes.get(name) if isinstance(attributes, dict) else None
    if isinstance(value, list) and value and isinstance(value[0], str):
        return value[0]
    return value if isinstance(value, str) else ""


def _invite_state(user: dict[str, Any]) -> tuple[str, int | None]:
    state = _attribute(user, "invite_status")
    try:
        expires_at = int(_attribute(user, "invite_expires_at"))
    except (TypeError, ValueError):
        expires_at = None
    if state == _PENDING and (expires_at is None or expires_at < int(time.time())):
        state = "expired"
    return state, expires_at


def _with_invite_summary(user: dict[str, Any], roles: list[str], checkpoint_id: str | None = None,
                         can_manage: bool = False, zone_ids: list[str] | None = None) -> dict[str, Any]:
    state, expires_at = _invite_state(user)
    return {
        **keycloak_admin._user_summary(user, roles, checkpoint_id, can_manage, zone_ids),
        "inviteStatus": state or None,
        "inviteExpiresAt": expires_at,
    }


def _new_invite_values() -> tuple[str, str, int]:
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode("ascii")).hexdigest(), int(time.time()) + settings.INVITE_TTL_SECONDS


def _attributes_with_invite(user: dict[str, Any], token_hash: str, expires_at: int, state: str = _PENDING) -> dict[str, list[str]]:
    attributes = user.get("attributes")
    merged: dict[str, list[str]] = {}
    if isinstance(attributes, dict):
        for key, value in attributes.items():
            if isinstance(key, str) and isinstance(value, list) and all(isinstance(item, str) for item in value):
                merged[key] = value
            elif isinstance(key, str) and isinstance(value, str):
                merged[key] = [value]
    merged.update({
        "invite_status": [state],
        "invite_nonce_hash": [token_hash] if token_hash else [],
        "invite_expires_at": [str(expires_at)] if expires_at else [],
    })
    return merged


def _invitation_state_was_saved(user: dict[str, Any], token_hash: str, expires_at: int) -> bool:
    saved_hash = _attribute(user, "invite_nonce_hash")
    return (
        _attribute(user, "invite_status") == _PENDING and
        _attribute(user, "invite_expires_at") == str(expires_at) and
        bool(saved_hash) and hmac.compare_digest(saved_hash, token_hash)
    )


def _raise_invitation_state_not_saved() -> None:
    raise HTTPException(
        503,
        "Keycloak did not save the invitation state. Run the invitation setup check and apply commands, then retry; no invitation email was sent.",
    )


def _audit_event(action: str, actor_id: str, user_id: str, *, email: str = "",
                 role: str = "", checkpoint_id: str | None = None,
                 zone_ids: list[str] | None = None, expires_at: int | None = None) -> AuditEvent:
    now = datetime.now(timezone.utc)
    return AuditEvent(id=str(uuid.uuid4()), created_at=now, data={
        "category": "account_invitation", "action": action, "actorId": actor_id,
        "userId": user_id, "email": email, "role": role,
        "checkpointId": checkpoint_id, "zoneIds": zone_ids or [],
        "zoneId": (zone_ids or [None])[0],
        "expiresAt": datetime.fromtimestamp(expires_at, timezone.utc).isoformat() if expires_at else None,
        "createdAt": now.isoformat(),
    })


def _email_body_name(user: dict[str, Any]) -> str:
    return " ".join(part for part in (user.get("firstName", ""), user.get("lastName", "")) if isinstance(part, str)).strip()


async def _find_user_by_email(token: str, email: str) -> dict[str, Any] | None:
    response = await keycloak_admin._request(token, "GET", f"users?email={quote(email, safe='')}&exact=true&first=0&max=2")
    users = response.json()
    if not isinstance(users, list):
        raise HTTPException(502, "Keycloak returned an invalid user search response")
    matches = [user for user in users if isinstance(user, dict) and isinstance(user.get("id"), str) and
               isinstance(user.get("email"), str) and user["email"].casefold() == email]
    if len(matches) > 1:
        raise HTTPException(409, "More than one Keycloak account uses this email. Resolve the duplicate before inviting.")
    return matches[0] if matches else None


async def _save_access_assignments(db: AsyncSession, user_id: str, actor_id: str,
                                   checkpoint_id: str | None, zone_ids: list[str]) -> tuple[str | None, list[str], bool]:
    identity = "browser:" + user_id
    previous_checkpoint_row = await db.get(TerminalCheckpointAssignment, identity)
    previous_checkpoint = previous_checkpoint_row.checkpoint_id if previous_checkpoint_row else None
    previous_zones = list(await db.scalars(select(ZoneAdminAssignment.zone_id).where(
        ZoneAdminAssignment.admin_subject == user_id).order_by(ZoneAdminAssignment.zone_id)))
    if checkpoint_id != previous_checkpoint:
        await set_checkpoint_assignment(db, identity, checkpoint_id, actor_id)
        await enqueue_checkpoint_assignment(db, identity)
    if zone_ids != previous_zones:
        await keycloak_admin._replace_zone_assignments(db, user_id, zone_ids, actor_id)
    changed = checkpoint_id != previous_checkpoint or zone_ids != previous_zones
    if changed:
        await enqueue_changed(db)
    return previous_checkpoint, previous_zones, changed


async def _restore_access_assignments(db: AsyncSession, user_id: str, actor_id: str,
                                      previous_checkpoint: str | None, previous_zones: list[str]) -> None:
    identity = "browser:" + user_id
    await set_checkpoint_assignment(db, identity, previous_checkpoint, actor_id)
    await enqueue_checkpoint_assignment(db, identity)
    await keycloak_admin._replace_zone_assignments(db, user_id, previous_zones, actor_id)
    await enqueue_changed(db)
    await db.commit()


async def _require_invite_scope(db: AsyncSession, actor: dict, user_id: str, roles: list[str]) -> None:
    if has_master_admin_role(actor):
        return
    if roles and roles != ["operator"]:
        raise HTTPException(404, "Invitation was not found")
    allowed_zones = await admin_zone_ids(db, actor)
    if roles:
        assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id)
        checkpoint = await db.get(Checkpoint, assignment.checkpoint_id) if assignment else None
        if checkpoint is None or checkpoint.zone_id not in allowed_zones:
            raise HTTPException(404, "Invitation was not found")
        return
    previous_assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id)
    previous_checkpoint = await db.get(Checkpoint, previous_assignment.checkpoint_id) if previous_assignment else None
    previous_zones = set(await db.scalars(select(ZoneAdminAssignment.zone_id).where(
        ZoneAdminAssignment.admin_subject == user_id)))
    if previous_zones or (previous_checkpoint and previous_checkpoint.zone_id not in allowed_zones):
        raise HTTPException(404, "Invitation was not found")


@router.get("")
async def list_invitations(
    search: str = Query("", max_length=100),
    first: int = Query(0, ge=0),
    max_results: int = Query(50, alias="max", ge=1, le=100),
    token: str = Depends(keycloak_admin._admin_context),
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    # Keycloak is the live invitation source of truth; Postgres stores only
    # the project audit history and existing zone/checkpoint assignments.
    query = f"users?q=invite_status:{_PENDING}&first={first}&max={max_results}&briefRepresentation=false"
    if search.strip():
        query += f"&search={quote(search.strip(), safe='')}"
    response = await keycloak_admin._request(token, "GET", query)
    users = response.json()
    if not isinstance(users, list):
        raise HTTPException(502, "Keycloak returned an invalid invitation directory")
    user_rows = [user for user in users if isinstance(user, dict) and isinstance(user.get("id"), str)]
    role_limit = asyncio.Semaphore(8)

    async def get_roles(user_id: str) -> tuple[str, list[str]]:
        async with role_limit:
            return user_id, await keycloak_admin._user_roles(token, user_id)

    roles_by_user = dict(await asyncio.gather(*(get_roles(user["id"]) for user in user_rows)))
    items = []
    for user in user_rows:
        status, _ = _invite_state(user)
        if status not in {_PENDING, "expired"}:
            continue
        roles = roles_by_user.get(user["id"], [])
        if not has_master_admin_role(actor) and not roles:
            continue
        try:
            await _require_invite_scope(db, actor, user["id"], roles)
        except HTTPException as error:
            if error.status_code == 404:
                continue
            raise
        items.append(_with_invite_summary(user, roles, can_manage=keycloak_admin.can_manage_user(
            has_master_admin_role(actor), roles)))
    return {"items": items, "first": first, "max": max_results,
            "hasMore": len(user_rows) == max_results,
            "nextFirst": first + max_results if len(user_rows) == max_results else None}


@router.post("", status_code=201)
async def create_invitation(payload: InviteCreateRequest,
    token: str = Depends(keycloak_admin._admin_context), db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    master_admin = has_master_admin_role(actor)
    if not master_admin and payload.role != "operator":
        raise HTTPException(403, "Zone admins may invite operator accounts only")
    if payload.role == "operator":
        if not payload.checkpoint_id:
            raise HTTPException(422, "Assign a checkpoint before inviting an operator")
        if payload.zone_ids:
            raise HTTPException(422, "Operator invitations use a checkpoint, not administrator zones")
        await require_checkpoint_scope(db, actor, payload.checkpoint_id)
        checkpoint_id = payload.checkpoint_id
        zone_ids: list[str] = []
    else:
        if payload.checkpoint_id:
            raise HTTPException(422, "Zone-admin invitations use assigned zones, not an operator checkpoint")
        if not payload.zone_ids:
            raise HTTPException(422, "Assign at least one zone before inviting a zone admin")
        from access_validation import validate_registered_zones
        zone_ids = await validate_registered_zones(db, payload.zone_ids)
        checkpoint_id = None

    ensure_invitation_mail_ready()
    previous_roles: list[str] = []
    existing = await _find_user_by_email(token, payload.email)
    created = existing is None
    if existing:
        user_id = existing["id"]
        await keycloak_admin._lock_user(db, user_id)
        old_status, _ = _invite_state(existing)
        previous_roles = await keycloak_admin._user_roles(token, user_id)
        await _require_invite_scope(db, actor, user_id, previous_roles)
        if old_status == _PENDING or old_status == "expired":
            raise HTTPException(409, "An invitation already exists for this email. Use resend to issue a fresh link.")
        if old_status == _ACCEPTED or (previous_roles and old_status != _REVOKED):
            raise HTTPException(409, "An InOut account already exists for this email.")
        if existing.get("enabled") is True and old_status != _REVOKED:
            raise HTTPException(409, "This active account cannot be converted into an invitation.")

    invite_token, token_hash, expires_at = _new_invite_values()
    if created:
        creation = await keycloak_admin._request(token, "POST", "users", {
            "username": payload.email, "firstName": payload.first_name, "lastName": payload.last_name,
            "email": payload.email, "enabled": False, "emailVerified": False,
            "attributes": {"invite_status": [_PENDING], "invite_nonce_hash": [token_hash],
                           "invite_expires_at": [str(expires_at)]},
        })
        location = creation.headers.get("Location", "")
        user_id = location.rstrip("/").rsplit("/", 1)[-1]
        if not user_id:
            raise HTTPException(502, "Keycloak created a disabled account but did not return its ID. Inspect the account before retrying.")
        current = {"id": user_id, "username": payload.email, "firstName": payload.first_name,
                   "lastName": payload.last_name, "email": payload.email, "enabled": False,
                   "emailVerified": False, "attributes": {}}
    else:
        user_id = existing["id"]
        current = existing
        update = {**existing, "firstName": payload.first_name, "lastName": payload.last_name,
                  "email": payload.email, "enabled": False, "emailVerified": False,
                  "attributes": _attributes_with_invite(existing, token_hash, expires_at)}
        await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", update)

    previous_checkpoint: str | None = None
    previous_zones: list[str] = []
    assignment_saved = False
    role_attempted = False
    try:
        previous_checkpoint, previous_zones, assignment_saved = await _save_access_assignments(
            db, user_id, actor["sub"], checkpoint_id, zone_ids)
        role_attempted = True
        roles = await keycloak_admin._replace_roles(token, user_id, [payload.role])
        saved = (await keycloak_admin._request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
        if not isinstance(saved, dict) or not _invitation_state_was_saved(saved, token_hash, expires_at):
            _raise_invitation_state_not_saved()
        db.add(_audit_event("created", actor["sub"], user_id, email=payload.email,
            role=payload.role, checkpoint_id=checkpoint_id, zone_ids=zone_ids, expires_at=expires_at))
        await db.commit()
    except Exception as error:
        await db.rollback()
        cleanup_failed = False
        if role_attempted:
            try:
                await keycloak_admin._replace_roles(token, user_id, previous_roles)
            except Exception:
                cleanup_failed = True
                logger.exception("Failed to restore roles for invitation account %s", user_id)
        try:
            if created:
                await keycloak_admin._request(token, "DELETE", f"users/{quote(user_id, safe='')}")
            else:
                await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", current)
        except Exception:
            cleanup_failed = True
            logger.exception("Failed to restore Keycloak account after invite creation %s", user_id)
            try:
                await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", {**current, "enabled": False})
            except Exception:
                logger.exception("Failed to disable incomplete invitation account %s", user_id)
        if assignment_saved:
            try:
                await _restore_access_assignments(db, user_id, actor["sub"], previous_checkpoint, previous_zones)
            except Exception:
                cleanup_failed = True
                await db.rollback()
                logger.exception("Failed to restore app assignments after invite creation %s", user_id)
        if cleanup_failed:
            raise HTTPException(503, "Invitation creation was incomplete. The account was disabled where possible; inspect it before retrying.") from error
        raise keycloak_admin._recovered_failure(error, "No invitation was sent; the account changes were rolled back.") from error

    # Delivery follows durable pending state. If SMTP fails, the disabled
    # invitation remains visible and an admin can safely resend it.
    await send_invitation(payload.email, _email_body_name(saved), user_id, invite_token)
    saved["attributes"] = _attributes_with_invite(saved, token_hash, expires_at)
    return _with_invite_summary(saved, roles, checkpoint_id,
        keycloak_admin.can_manage_user(master_admin, roles), zone_ids if payload.role == "zone-admin" else [])


@router.post("/{user_id}/resend")
async def resend_invitation(user_id: str, token: str = Depends(keycloak_admin._admin_context),
    payload: InviteResendRequest = Body(default=InviteResendRequest()),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    ensure_invitation_mail_ready()
    await keycloak_admin._lock_user(db, user_id)
    current_response = await keycloak_admin._request(token, "GET", f"users/{quote(user_id, safe='')}")
    current = current_response.json()
    if not isinstance(current, dict) or not isinstance(current.get("id"), str):
        raise HTTPException(404, "Invitation was not found")
    roles = await keycloak_admin._user_roles(token, user_id)
    await _require_invite_scope(db, actor, user_id, roles)
    invite_state, _ = _invite_state(current)
    legacy_disabled_account = (
        invite_state == "" and current.get("enabled") is not True and
        bool(current.get("email")) and bool(set(roles) & {"operator", "zone-admin"}) and
        "master-admin" not in roles
    )
    if current.get("enabled") is True or (
        invite_state not in {_PENDING, "expired", _REVOKED} and not legacy_disabled_account
    ):
        raise HTTPException(409, "Only a pending or revoked invitation can be resent")
    previous_email = current.get("email", "")
    requested_email = payload.email or previous_email
    if not requested_email:
        raise HTTPException(422, "Set an email address before resending the invitation")
    if requested_email != previous_email:
        if not has_master_admin_role(actor):
            raise HTTPException(403, "Only a master-admin can change an invitation email address")
        existing = await _find_user_by_email(token, requested_email)
        if existing is not None and existing.get("id") != user_id:
            raise HTTPException(409, "Another Keycloak account already uses this email address")
    invite_token, token_hash, expires_at = _new_invite_values()
    await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", {
        **current, "email": requested_email,
        "emailVerified": current.get("emailVerified", False) if requested_email == previous_email else False,
        "enabled": False,
        "attributes": _attributes_with_invite(current, token_hash, expires_at),
    })
    saved_response = await keycloak_admin._request(token, "GET", f"users/{quote(user_id, safe='')}")
    saved = saved_response.json()
    if not isinstance(saved, dict) or not _invitation_state_was_saved(saved, token_hash, expires_at):
        try:
            await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", current)
        except Exception:
            logger.exception("Failed to restore account after Keycloak discarded invitation state for %s", user_id)
        _raise_invitation_state_not_saved()
    current["email"] = requested_email
    if requested_email != previous_email:
        current["emailVerified"] = False
    current["enabled"] = False
    current["attributes"] = _attributes_with_invite(current, token_hash, expires_at)
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))"),
        {"identity": "keycloak-invite-audit:" + user_id})
    db.add(_audit_event("resent", actor["sub"], user_id, email=requested_email, expires_at=expires_at))
    await db.commit()
    await send_invitation(requested_email, _email_body_name(current), user_id, invite_token)
    return _with_invite_summary(current, roles, can_manage=keycloak_admin.can_manage_user(
        has_master_admin_role(actor), roles))


@router.delete("/{user_id}", status_code=200)
async def revoke_invitation(user_id: str, token: str = Depends(keycloak_admin._admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, bool]:
    await keycloak_admin._lock_user(db, user_id)
    current = (await keycloak_admin._request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    if not isinstance(current, dict):
        raise HTTPException(404, "Invitation was not found")
    roles = await keycloak_admin._user_roles(token, user_id)
    await _require_invite_scope(db, actor, user_id, roles)
    if _attribute(current, "invite_status") != _PENDING or current.get("enabled") is True:
        raise HTTPException(409, "Only an unaccepted invitation can be revoked")
    await keycloak_admin._request(token, "PUT", f"users/{quote(user_id, safe='')}", {
        **current, "enabled": False,
        "attributes": _attributes_with_invite(current, "", 0, _REVOKED),
    })
    db.add(_audit_event("revoked", actor["sub"], user_id, email=current.get("email", "")))
    await db.commit()
    return {"revoked": True}


async def _invite_service_token() -> str:
    if not settings.KEYCLOAK_INVITE_CLIENT_SECRET:
        raise HTTPException(503, "The invitation identity client is not configured")
    base = keycloak_admin._keycloak_base()
    realm = keycloak_admin._realm_name()
    try:
        response = await get_keycloak_admin_client().post(
            f"{base}/realms/{quote(realm, safe='')}/protocol/openid-connect/token",
            data={"grant_type": "client_credentials", "client_id": settings.KEYCLOAK_INVITE_CLIENT_ID,
                  "client_secret": settings.KEYCLOAK_INVITE_CLIENT_SECRET},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError as error:
        raise HTTPException(503, "The invitation identity service is unavailable") from error
    if response.status_code >= 400:
        logger.error("Invitation service-token request failed with HTTP %s", response.status_code)
        raise HTTPException(503, "The invitation identity service is unavailable")
    try:
        access_token = response.json().get("access_token")
    except (ValueError, AttributeError):
        access_token = None
    if not isinstance(access_token, str) or not access_token:
        raise HTTPException(503, "The invitation identity service returned an invalid response")
    return access_token


async def _service_user_request(token: str, method: str, user_id: str, payload: dict[str, Any] | None = None) -> httpx.Response:
    base = keycloak_admin._keycloak_base()
    realm = keycloak_admin._realm_name()
    try:
        response = await get_keycloak_admin_client().request(
            method, f"{base}/admin/realms/{quote(realm, safe='')}/users/{quote(user_id, safe='')}",
            headers={"Authorization": f"Bearer {token}"}, json=payload,
        )
    except httpx.HTTPError as error:
        raise HTTPException(503, "The invitation identity service is unavailable") from error
    if response.status_code == 404:
        return response
    if response.status_code >= 500:
        raise HTTPException(503, "The invitation identity service is unavailable")
    if response.status_code >= 400:
        logger.error("Invitation service account request failed with HTTP %s", response.status_code)
        raise HTTPException(503, "The invitation identity client is not authorized")
    return response


@router.post("/accept")
async def accept_invitation(payload: PublicInviteAcceptRequest, db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    if not _TOKEN_RE.fullmatch(payload.token):
        raise HTTPException(400, "This invitation link cannot be used. Request a new invitation.")
    # Serialize every accept/resend/revoke operation for this Keycloak user.
    # Keycloak remains the invitation state store; this transaction only holds
    # a short-lived advisory lock while the one-time state transition runs.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))"),
        {"identity": "keycloak-user:" + payload.user_id})
    service_token = await _invite_service_token()
    response = await _service_user_request(service_token, "GET", payload.user_id)
    if response.status_code == 404:
        raise HTTPException(400, "This invitation link cannot be used. Request a new invitation.")
    user = response.json()
    if not isinstance(user, dict):
        raise HTTPException(503, "The invitation identity service returned an invalid response")
    state = _attribute(user, "invite_status")
    stored_hash = _attribute(user, "invite_nonce_hash")
    try:
        expires_at = int(_attribute(user, "invite_expires_at"))
    except (TypeError, ValueError):
        expires_at = 0
    supplied_hash = hashlib.sha256(payload.token.encode("ascii")).hexdigest()
    valid = (state == _PENDING and user.get("enabled") is False and expires_at >= int(time.time())
             and bool(stored_hash) and hmac.compare_digest(stored_hash, supplied_hash))
    if not valid:
        raise HTTPException(400, "This invitation link cannot be used. Request a new invitation.")

    updated_attributes = _attributes_with_invite(user, "", 0, _ACCEPTED)
    await _service_user_request(service_token, "PUT", payload.user_id, {
        **user, "enabled": True, "emailVerified": True, "attributes": updated_attributes,
    })
    confirmed = (await _service_user_request(service_token, "GET", payload.user_id)).json()
    if (not isinstance(confirmed, dict) or confirmed.get("enabled") is not True or
            _attribute(confirmed, "invite_status") != _ACCEPTED or
            _attribute(confirmed, "invite_nonce_hash") or _attribute(confirmed, "invite_expires_at")):
        raise HTTPException(503, "Invitation acceptance could not be confirmed. Contact an administrator before retrying.")
    db.add(_audit_event("accepted", payload.user_id, payload.user_id, email=confirmed.get("email", "")))
    await db.commit()
    return {"accepted": True}
