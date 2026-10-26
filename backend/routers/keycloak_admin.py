"""Application-scoped Keycloak user administration.

Keycloak remains the identity authority.  This router exposes only the user
and role operations the InOut dashboard needs and forwards the signed-in
administrator's bearer token to Keycloak's Admin REST API. It deliberately has
no delete-user endpoint.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any, Literal
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from auth import has_master_admin_role, verify_admin_request
from config import settings
from database import get_db
from keycloak_http import get_keycloak_admin_client
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from models import Checkpoint, OrganizationZone, TerminalCheckpointAssignment, ZoneAdminAssignment
from event_outbox import enqueue_changed
from terminal_assignments import publish_checkpoint_assignment, enqueue_checkpoint_assignment, set_checkpoint_assignment
from user_management_step_up import verified_user_management_window
from user_management_locks import get_window_guard_db, require_unlocked_window
from user_management_policy import MASTER_ADMIN_ROLE, can_manage_user, can_update_user_fields
from zone_access import admin_zone_ids, require_checkpoint_scope

router = APIRouter(prefix="/v1/keycloak", tags=["keycloak"])
_bearer = HTTPBearer(auto_error=False)
APP_ROLES = frozenset({"admin", "operator", MASTER_ADMIN_ROLE})
ASSIGNABLE_ROLES = frozenset({"admin", "operator"})
CheckpointId = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
logger = logging.getLogger(__name__)


class UserCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    first_name: str = Field("", alias="firstName", max_length=100)
    last_name: str = Field("", alias="lastName", max_length=100)
    email: str = Field("", max_length=320)
    password: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(min_length=8, max_length=128)
    temporary_password: bool = Field(True, alias="temporaryPassword")
    roles: list[Literal["admin", "operator"]] = Field(default_factory=list)
    enabled: bool = True
    checkpoint_id: CheckpointId | None = Field(None, alias="checkpointId")
    zone_ids: list[str] = Field(default_factory=list, alias="zoneIds", max_length=100)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        if value and ("@" not in value or value.startswith("@") or value.endswith("@")):
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("password")
    @classmethod
    def valid_password(cls, value: str) -> str:
        return _validate_password_policy(value)


class UserUpdateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    first_name: str | None = Field(None, alias="firstName", max_length=100)
    last_name: str | None = Field(None, alias="lastName", max_length=100)
    email: str | None = Field(None, max_length=320)
    enabled: bool | None = None
    checkpoint_id: CheckpointId | None = Field(None, alias="checkpointId")
    roles: list[Literal["admin", "operator"]] | None = None
    zone_ids: list[str] | None = Field(None, alias="zoneIds", max_length=100)

    @field_validator("roles", mode="before")
    @classmethod
    def roles_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("Roles must be a list when provided")
        return value

    @field_validator("zone_ids", mode="before")
    @classmethod
    def zone_ids_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("Zone IDs must be a list when provided")
        return value

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str | None) -> str | None:
        if value and ("@" not in value or value.startswith("@") or value.endswith("@")):
            raise ValueError("Enter a valid email address")
        return value


class RolesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    roles: list[Literal["admin", "operator"]]


class PasswordResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=8, max_length=128)
    temporary: bool = True

    @field_validator("password")
    @classmethod
    def valid_password(cls, value: str) -> str:
        return _validate_password_policy(value)


async def _admin_context(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    step_up: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
    db: AsyncSession = Depends(get_window_guard_db),
    request: Request = None,
) -> str:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    claims = await verify_admin_request(credentials, request)
    window = verified_user_management_window(credentials.credentials, claims, step_up, now=time.time())
    await require_unlocked_window(db, claims, window)
    return credentials.credentials


def _keycloak_base() -> str:
    if settings.KEYCLOAK_ADMIN_BASE:
        return settings.KEYCLOAK_ADMIN_BASE.rstrip("/")
    source = settings.KEYCLOAK_JWKS_BASE or settings.KEYCLOAK_ISSUER
    marker = "/realms/"
    if marker not in source:
        raise HTTPException(status_code=503, detail="Keycloak Admin API is not configured")
    return source.split(marker, 1)[0].rstrip("/")


def _realm_name() -> str:
    marker = "/realms/"
    if marker not in settings.KEYCLOAK_ISSUER:
        raise HTTPException(status_code=503, detail="Keycloak realm is not configured")
    return settings.KEYCLOAK_ISSUER.split(marker, 1)[1].split("/", 1)[0]


async def _request(token: str, method: str, path: str, payload: Any = None) -> httpx.Response:
    try:
        response = await get_keycloak_admin_client().request(
            method,
            f"{_keycloak_base()}/admin/realms/{_realm_name()}/{path.lstrip('/')}",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Identity service is unavailable") from exc
    if response.status_code == 403:
        raise HTTPException(status_code=403, detail="Keycloak user-management permission is required")
    if response.status_code == 404:
        raise HTTPException(status_code=404, detail="Keycloak user was not found")
    if response.status_code >= 400:
        detail = "Keycloak rejected the request"
        try:
            body = response.json()
            if isinstance(body, dict) and isinstance(body.get("errorMessage"), str):
                detail = body["errorMessage"]
        except ValueError:
            pass
        status = response.status_code if response.status_code in {401, 409, 429} else 503 if response.status_code >= 500 else 400
        raise HTTPException(status_code=status, detail=detail)
    return response


def _user_summary(user: dict[str, Any], roles: list[str] | None = None,
    checkpoint_id: str | None = None, can_manage: bool = False,
    zone_ids: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": user.get("id"),
        "username": user.get("username", ""),
        "firstName": user.get("firstName", ""),
        "lastName": user.get("lastName", ""),
        "email": user.get("email", ""),
        "enabled": bool(user.get("enabled", False)),
        "emailVerified": bool(user.get("emailVerified", False)),
        "createdTimestamp": user.get("createdTimestamp"),
        "checkpointId": checkpoint_id,
        "zoneIds": zone_ids or [],
        "canManage": can_manage,
        **({"roles": roles} if roles is not None else {}),
    }


async def _user_roles(token: str, user_id: str) -> list[str]:
    response = await _request(token, "GET", f"users/{quote(user_id, safe='')}/role-mappings/realm")
    mappings = response.json()
    return sorted(mapping["name"] for mapping in mappings if isinstance(mapping, dict) and mapping.get("name") in APP_ROLES)


async def _replace_roles(token: str, user_id: str, requested: list[str], mutations: list[str] | None = None) -> list[str]:
    current_response = await _request(token, "GET", f"users/{quote(user_id, safe='')}/role-mappings/realm")
    # Only normal application roles are mutable here. master-admin is
    # provisioned separately and cannot be granted or removed by this API.
    current = [role for role in current_response.json() if isinstance(role, dict) and role.get("name") in ASSIGNABLE_ROLES]
    role_models: list[dict[str, Any]] = []
    for role in sorted(set(requested)):
        role_models.append((await _request(token, "GET", f"roles/{quote(role, safe='')}")).json())
    path = f"users/{quote(user_id, safe='')}/role-mappings/realm"
    current_names = {role["name"] for role in current}
    additions = [role for role in role_models if role["name"] not in current_names]
    removals = [role for role in current if role["name"] not in requested]
    for method, roles in (("POST", additions), ("DELETE", removals)):
        if not roles:
            continue
        if mutations is not None:
            mutations.append(method)
        try:
            await _request(token, method, path, roles)
        except HTTPException as error:
            if mutations is not None and error.status_code < 500:
                mutations.pop()  # A definite rejection did not perform this write.
            raise
    saved_roles = await _user_roles(token, user_id)
    if saved_roles != sorted(set(requested)):
        raise HTTPException(502, "Keycloak did not confirm the requested account roles")
    return saved_roles


async def _lock_user(db: AsyncSession, user_id: str) -> None:
    # Serialize this application's saves while provider and assignment state are
    # being reconciled. Keycloak itself remains an external identity authority.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))"),
        {"identity": "keycloak-user:" + user_id})


async def _replace_zone_assignments(db: AsyncSession, user_id: str, zone_ids: list[str], actor_id: str) -> None:
    current = list(await db.scalars(select(ZoneAdminAssignment).where(
        ZoneAdminAssignment.admin_subject == user_id).with_for_update()))
    for assignment in current:
        await db.delete(assignment)
    for zone_id in zone_ids:
        db.add(ZoneAdminAssignment(admin_subject=user_id, zone_id=zone_id, assigned_by=actor_id))


def _profile_body(user: dict[str, Any]) -> dict[str, Any]:
    return {key: user.get(key, "" if key not in {"enabled", "emailVerified"} else False)
        for key in ("username", "firstName", "lastName", "email", "enabled", "emailVerified")}


def _recovered_failure(error: Exception, message: str) -> HTTPException:
    if isinstance(error, HTTPException):
        return HTTPException(error.status_code, f"{error.detail}. {message}")
    return HTTPException(503, message)


@router.get("/users")
async def list_users(
    search: str = Query("", max_length=100),
    first: int = Query(0, ge=0),
    max_results: int = Query(50, alias="max", ge=1, le=100),
    token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    query = f"users?briefRepresentation=true&first={first}&max={max_results}"
    if search.strip():
        query += f"&search={quote(search.strip(), safe='')}"
    users = (await _request(token, "GET", query)).json()
    users = [user for user in users if isinstance(user, dict)]
    identities = ["browser:" + user["id"] for user in users if isinstance(user.get("id"), str)]
    assignments = (await db.execute(select(TerminalCheckpointAssignment)
        .where(TerminalCheckpointAssignment.terminal_identity.in_(identities)))).scalars().all()
    checkpoints = {assignment.terminal_identity: assignment.checkpoint_id for assignment in assignments}
    checkpoint_rows = await db.scalars(select(Checkpoint).where(
        Checkpoint.id.in_(set(checkpoints.values()) or {"__none__"})))
    checkpoint_zones = {checkpoint.id: checkpoint.zone_id for checkpoint in checkpoint_rows}
    zone_assignments = await db.scalars(select(ZoneAdminAssignment).where(
        ZoneAdminAssignment.admin_subject.in_([user["id"] for user in users if isinstance(user.get("id"), str)] or ["__none__"])))
    zones_by_user: dict[str, list[str]] = {}
    for assignment in zone_assignments:
        zones_by_user.setdefault(assignment.admin_subject, []).append(assignment.zone_id)
    role_limit = asyncio.Semaphore(8)

    async def user_roles(user_id: str) -> tuple[str, list[str]]:
        async with role_limit:
            return user_id, await _user_roles(token, user_id)

    user_ids = [user["id"] for user in users if isinstance(user.get("id"), str)]
    roles_by_user = dict(await asyncio.gather(*(user_roles(user_id) for user_id in user_ids)))
    allowed_zones = await admin_zone_ids(db, actor)
    if not has_master_admin_role(actor):
        users = [user for user in users
            if roles_by_user.get(user.get("id", ""), []) == ["operator"]
            and checkpoint_zones.get(checkpoints.get("browser:" + user.get("id", ""), "")) in allowed_zones]
    return {
        "items": [
            _user_summary(
                user,
                roles_by_user.get(user.get("id", ""), []),
                checkpoints.get("browser:" + user.get("id", "")),
                can_manage_user(has_master_admin_role(actor), roles_by_user.get(user.get("id", ""), [])),
                zones_by_user.get(user.get("id", ""), []),
            )
            for user in users
        ],
        "first": first,
        "max": max_results,
    }


@router.get("/users/{user_id}")
async def get_user(user_id: str, token: str = Depends(_admin_context), db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id)
    roles = await _user_roles(token, user_id)
    checkpoint_id = assignment.checkpoint_id if assignment else None
    if not can_manage_user(has_master_admin_role(actor), roles):
        raise HTTPException(404, "User not found")
    if not has_master_admin_role(actor):
        allowed_zones = await admin_zone_ids(db, actor)
        checkpoint = await db.get(Checkpoint, checkpoint_id) if checkpoint_id else None
        if roles != ["operator"] or checkpoint is None or checkpoint.zone_id not in allowed_zones:
            raise HTTPException(404, "User not found")
    zone_ids = list(await db.scalars(select(ZoneAdminAssignment.zone_id).where(
        ZoneAdminAssignment.admin_subject == user_id).order_by(ZoneAdminAssignment.zone_id)))
    return _user_summary(user, roles, checkpoint_id,
        can_manage_user(has_master_admin_role(actor), roles), zone_ids)


@router.post("/users", status_code=201)
async def create_user(payload: UserCreateRequest, token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    if not has_master_admin_role(actor):
        raise HTTPException(403, "Only a master-admin can create identity accounts")
    if "operator" in payload.roles and not payload.checkpoint_id:
        raise HTTPException(422, "Assign a checkpoint when creating an operator account")
    if "admin" in payload.roles and not payload.zone_ids:
        raise HTTPException(422, "Assign at least one zone when creating an admin account")
    if payload.zone_ids:
        from access_validation import validate_registered_zones
        payload.zone_ids = await validate_registered_zones(db, payload.zone_ids)
    if payload.checkpoint_id:
        await require_checkpoint_scope(db, actor, payload.checkpoint_id)
    try:
        response = await _request(token, "POST", "users", {
            "username": payload.username,
            "firstName": payload.first_name,
            "lastName": payload.last_name,
            "email": payload.email,
            # Keep an incompletely provisioned account unable to sign in.
            "enabled": False,
            "emailVerified": False,
        })
    except HTTPException as error:
        if error.status_code >= 500:
            raise HTTPException(error.status_code, f"Unable to confirm creation for {payload.username}. Inspect Keycloak for a disabled account before retrying.") from error
        raise
    location = response.headers.get("Location", "")
    user_id = location.rstrip("/").rsplit("/", 1)[-1]
    if not user_id:
        raise HTTPException(status_code=502, detail=f"Creation incomplete for {payload.username}: Keycloak did not return the account ID. The account was created disabled; inspect it in Keycloak before retrying.")
    identity = "browser:" + user_id
    assignment_saved = False
    try:
        await _request(token, "PUT", f"users/{quote(user_id, safe='')}/reset-password", {
            "type": "password", "value": payload.password, "temporary": payload.temporary_password,
        })
        if payload.checkpoint_id:
            await set_checkpoint_assignment(db, identity, payload.checkpoint_id, actor["sub"])
            await enqueue_checkpoint_assignment(db, identity)
        if "admin" in payload.roles:
            await _replace_zone_assignments(db, user_id, payload.zone_ids, actor["sub"])
        roles = await _replace_roles(token, user_id, payload.roles)
        if payload.enabled:
            await _request(token, "PUT", f"users/{quote(user_id, safe='')}", {"enabled": True})
        user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
        if payload.checkpoint_id or "admin" in payload.roles:
            await enqueue_changed(db)
            await db.commit()
            assignment_saved = True
    except Exception as error:
        await db.rollback()
        cleanup_failed = False
        try:
            await _request(token, "DELETE", f"users/{quote(user_id, safe='')}")
        except Exception:
            cleanup_failed = True
            logger.exception("Failed to remove incompletely provisioned Keycloak user %s", user_id)
            try:
                await _request(token, "PUT", f"users/{quote(user_id, safe='')}", {"enabled": False})
            except Exception:
                logger.exception("Failed to disable incompletely provisioned Keycloak user %s", user_id)
        if assignment_saved:
            try:
                await set_checkpoint_assignment(db, identity, None, actor["sub"])
                await enqueue_checkpoint_assignment(db, identity)
                await db.commit()
            except Exception:
                cleanup_failed = True
                await db.rollback()
                logger.exception("Failed to remove incomplete checkpoint assignment %s", identity)
        if cleanup_failed:
            raise HTTPException(503, f"Creation incomplete. Recovery is required for Keycloak account {user_id} ({payload.username}); inspect the account before retrying.") from error
        raise _recovered_failure(error, "Creation was rolled back; the new account was removed. You can retry.") from error
    return _user_summary(user, roles, payload.checkpoint_id, can_manage_user(True, roles),
        payload.zone_ids if "admin" in roles else [])


@router.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UserUpdateRequest, token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    await _lock_user(db, user_id)
    current = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    previous_roles = await _user_roles(token, user_id)
    master_admin = has_master_admin_role(actor)
    if not can_manage_user(master_admin, previous_roles):
        raise HTTPException(403, "This account can only be managed by a master-admin")
    if not can_update_user_fields(master_admin, previous_roles, payload.model_fields_set):
        raise HTTPException(403, "Admins may change only an operator's enabled state and checkpoint")
    assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id, with_for_update=True)
    previous_checkpoint = assignment.checkpoint_id if assignment else None
    previous_zones = list(await db.scalars(select(ZoneAdminAssignment.zone_id).where(
        ZoneAdminAssignment.admin_subject == user_id).order_by(ZoneAdminAssignment.zone_id)))
    checkpoint = payload.checkpoint_id if "checkpoint_id" in payload.model_fields_set else previous_checkpoint
    requested_roles = sorted(set(payload.roles)) if payload.roles is not None else previous_roles
    if "operator" in requested_roles and not checkpoint:
        raise HTTPException(422, "Assign a checkpoint when granting or retaining the operator role")
    if not master_admin:
        allowed_zones = await admin_zone_ids(db, actor)
        assigned_checkpoint = await db.get(Checkpoint, previous_checkpoint) if previous_checkpoint else None
        if previous_roles != ["operator"] or assigned_checkpoint is None or assigned_checkpoint.zone_id not in allowed_zones:
            raise HTTPException(404, "User not found")
    if checkpoint:
        await require_checkpoint_scope(db, actor, checkpoint)
    if "admin" in requested_roles:
        target_zones = payload.zone_ids if payload.zone_ids is not None else previous_zones
        if not target_zones:
            raise HTTPException(422, "Assign at least one zone to every admin account")
        from access_validation import validate_registered_zones
        target_zones = await validate_registered_zones(db, target_zones)
    else:
        target_zones = []
    updates = payload.model_dump(exclude_none=True)
    if master_admin:
        body = {
            "username": current.get("username", ""),
            "firstName": updates.get("first_name", current.get("firstName", "")),
            "lastName": updates.get("last_name", current.get("lastName", "")),
            "email": updates.get("email", current.get("email", "")),
            "enabled": updates.get("enabled", current.get("enabled", False)),
            "emailVerified": current.get("emailVerified", False) if updates.get("email", current.get("email", "")) == current.get("email", "") else False,
        }
    else:
        # Keep ordinary-admin provider writes limited to the one permitted
        # Keycloak access flag. Checkpoint-only changes stay in PostgreSQL.
        body = {"enabled": updates["enabled"]} if "enabled" in updates else {}
    checkpoint_changed = checkpoint != previous_checkpoint
    zones_changed = target_zones != previous_zones
    profile_attempted = False
    role_mutations: list[str] = []
    try:
        if checkpoint_changed:
            await set_checkpoint_assignment(db, "browser:" + user_id, checkpoint, actor["sub"])
        if zones_changed:
            if not master_admin:
                raise HTTPException(403, "Only a master-admin can assign administrator zones")
            await _replace_zone_assignments(db, user_id, target_zones, actor["sub"])
        if body:
            profile_attempted = True
            try:
                await _request(token, "PUT", f"users/{quote(user_id, safe='')}", body)
            except HTTPException as error:
                if error.status_code < 500:
                    profile_attempted = False
                raise
        if requested_roles != previous_roles:
            await _replace_roles(token, user_id, requested_roles, role_mutations)
        saved = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
        saved_roles = await _user_roles(token, user_id)
        if checkpoint_changed or zones_changed:
            if checkpoint_changed:
                await enqueue_checkpoint_assignment(db, "browser:" + user_id)
            else:
                await enqueue_changed(db)
            await db.commit()
    except Exception as error:
        recovery_failed = False
        if role_mutations:
            try:
                await _replace_roles(token, user_id, previous_roles)
            except Exception:
                recovery_failed = True
                logger.exception("Failed to restore Keycloak roles for %s", user_id)
        if profile_attempted:
            try:
                await _request(token, "PUT", f"users/{quote(user_id, safe='')}", _profile_body(current))
            except Exception:
                recovery_failed = True
                logger.exception("Failed to restore Keycloak profile for %s", user_id)
        # Retain the advisory lock until provider compensation finishes so a
        # second application save cannot race the restoration.
        await db.rollback()
        if recovery_failed:
            raise HTTPException(503, f"Save incomplete. Recovery is required for Keycloak account {user_id}; reload its current state and inspect it in Keycloak before retrying.") from error
        raise _recovered_failure(error, "Save was rolled back; the previous account settings were restored.") from error
    return _user_summary(saved, saved_roles, checkpoint,
        can_manage_user(master_admin, saved_roles), target_zones)


@router.put("/users/{user_id}/roles")
async def replace_user_roles(user_id: str, payload: RolesRequest, token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    saved = await update_user(user_id, UserUpdateRequest(roles=payload.roles), token, db, actor)
    return {"roles": saved["roles"]}


@router.put("/users/{user_id}/password")
async def reset_password(user_id: str, payload: PasswordResetRequest, token: str = Depends(_admin_context),
    actor: dict = Depends(verify_admin_request)) -> dict[str, bool]:
    if not has_master_admin_role(actor):
        raise HTTPException(403, "Only a master-admin can reset account passwords")
    if not can_manage_user(True, await _user_roles(token, user_id)):
        raise HTTPException(403, "This account can only be managed through the master-admin bootstrap")
    await _request(token, "PUT", f"users/{quote(user_id, safe='')}/reset-password", {
        "type": "password", "value": payload.password, "temporary": payload.temporary,
    })
    return result


@router.post("/users/{user_id}/logout")
async def end_user_sessions(user_id: str, token: str = Depends(_admin_context),
    actor: dict = Depends(verify_admin_request)) -> dict[str, bool]:
    if not has_master_admin_role(actor):
        raise HTTPException(403, "Only a master-admin can end account sessions")
    if not can_manage_user(True, await _user_roles(token, user_id)):
        raise HTTPException(403, "This account can only be managed through the master-admin bootstrap")
    await _request(token, "POST", f"users/{quote(user_id, safe='')}/logout")
    return result
