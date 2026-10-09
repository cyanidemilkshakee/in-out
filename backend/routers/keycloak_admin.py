"""Application-scoped Keycloak user administration.

Keycloak remains the identity authority.  This router exposes only the user
and role operations the InOut dashboard needs and forwards the signed-in
administrator's bearer token to Keycloak's Admin REST API.  It never stores a
master-admin password and deliberately has no delete-user endpoint.
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from auth import verify_admin_request
from config import settings
from database import get_db
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from models import TerminalCheckpointAssignment
from terminal_assignments import publish_checkpoint_assignment, set_checkpoint_assignment
from user_management_step_up import require_user_management_step_up

router = APIRouter(prefix="/v1/keycloak", tags=["keycloak"])
_bearer = HTTPBearer(auto_error=False)
APP_ROLES = frozenset({"admin", "operator"})


class UserCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    first_name: str = Field("", alias="firstName", max_length=100)
    last_name: str = Field("", alias="lastName", max_length=100)
    email: str = Field("", max_length=320)
    password: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(min_length=12, max_length=128)
    temporary_password: bool = Field(True, alias="temporaryPassword")
    roles: list[Literal["admin", "operator"]] = Field(default_factory=list)
    enabled: bool = True
    checkpoint_id: Literal["cp-main", "server-room"] | None = Field(None, alias="checkpointId")

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        if value and ("@" not in value or value.startswith("@") or value.endswith("@")):
            raise ValueError("Enter a valid email address")
        return value


class UserUpdateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    first_name: str | None = Field(None, alias="firstName", max_length=100)
    last_name: str | None = Field(None, alias="lastName", max_length=100)
    email: str | None = Field(None, max_length=320)
    enabled: bool | None = None
    checkpoint_id: Literal["cp-main", "server-room"] | None = Field(None, alias="checkpointId")

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
    password: str = Field(min_length=12, max_length=128)
    temporary: bool = True


async def _admin_context(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    step_up: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
) -> str:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    claims = await verify_admin_request(credentials)
    require_user_management_step_up(credentials.credentials, claims, step_up, now=time.time())
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
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.request(
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


def _user_summary(user: dict[str, Any], roles: list[str] | None = None, checkpoint_id: str | None = None) -> dict[str, Any]:
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
        **({"roles": roles} if roles is not None else {}),
    }


async def _user_roles(token: str, user_id: str) -> list[str]:
    response = await _request(token, "GET", f"users/{quote(user_id, safe='')}/role-mappings/realm")
    mappings = response.json()
    return sorted(mapping["name"] for mapping in mappings if isinstance(mapping, dict) and mapping.get("name") in APP_ROLES)


async def _replace_roles(token: str, user_id: str, requested: list[str]) -> list[str]:
    current_response = await _request(token, "GET", f"users/{quote(user_id, safe='')}/role-mappings/realm")
    current = [role for role in current_response.json() if isinstance(role, dict) and role.get("name") in APP_ROLES]
    role_models: list[dict[str, Any]] = []
    for role in sorted(set(requested)):
        role_models.append((await _request(token, "GET", f"roles/{quote(role, safe='')}")).json())
    path = f"users/{quote(user_id, safe='')}/role-mappings/realm"
    current_names = {role["name"] for role in current}
    additions = [role for role in role_models if role["name"] not in current_names]
    removals = [role for role in current if role["name"] not in requested]
    if additions:
        await _request(token, "POST", path, additions)
    if removals:
        await _request(token, "DELETE", path, removals)
    return sorted(set(requested))


@router.get("/users")
async def list_users(
    search: str = Query("", max_length=100),
    first: int = Query(0, ge=0),
    max_results: int = Query(50, alias="max", ge=1, le=100),
    token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db),
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
    role_limit = asyncio.Semaphore(8)

    async def user_roles(user_id: str) -> tuple[str, list[str]]:
        async with role_limit:
            return user_id, await _user_roles(token, user_id)

    user_ids = [user["id"] for user in users if isinstance(user.get("id"), str)]
    roles_by_user = dict(await asyncio.gather(*(user_roles(user_id) for user_id in user_ids)))
    return {
        "items": [
            _user_summary(
                user,
                roles_by_user.get(user.get("id", ""), []),
                checkpoints.get("browser:" + user.get("id", "")),
            )
            for user in users
        ],
        "first": first,
        "max": max_results,
    }


@router.get("/users/{user_id}")
async def get_user(user_id: str, token: str = Depends(_admin_context), db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id)
    return _user_summary(user, await _user_roles(token, user_id), assignment.checkpoint_id if assignment else None)


@router.post("/users", status_code=201)
async def create_user(payload: UserCreateRequest, token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    if "operator" in payload.roles and not payload.checkpoint_id:
        raise HTTPException(422, "Assign a checkpoint when creating an operator account")
    response = await _request(token, "POST", "users", {
        "username": payload.username,
        "firstName": payload.first_name,
        "lastName": payload.last_name,
        "email": payload.email,
        "enabled": payload.enabled,
        "emailVerified": False,
    })
    location = response.headers.get("Location", "")
    user_id = location.rstrip("/").rsplit("/", 1)[-1]
    if not user_id:
        raise HTTPException(status_code=502, detail="Keycloak did not return the created user")
    await _request(token, "PUT", f"users/{quote(user_id, safe='')}/reset-password", {
        "type": "password", "value": payload.password, "temporary": payload.temporary_password,
    })
    if payload.checkpoint_id:
        await set_checkpoint_assignment(db, "browser:" + user_id, payload.checkpoint_id, actor["sub"])
        await db.commit()
        await publish_checkpoint_assignment("browser:" + user_id)
    roles = await _replace_roles(token, user_id, payload.roles)
    user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    return _user_summary(user, roles, payload.checkpoint_id)


@router.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UserUpdateRequest, token: str = Depends(_admin_context),
    db: AsyncSession = Depends(get_db), actor: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    current = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    updates = payload.model_dump(exclude_none=True)
    body = {
        "username": current.get("username", ""),
        "firstName": updates.get("first_name", current.get("firstName", "")),
        "lastName": updates.get("last_name", current.get("lastName", "")),
        "email": updates.get("email", current.get("email", "")),
        "enabled": updates.get("enabled", current.get("enabled", False)),
        "emailVerified": current.get("emailVerified", False) if updates.get("email", current.get("email", "")) == current.get("email", "") else False,
    }
    await _request(token, "PUT", f"users/{quote(user_id, safe='')}", body)
    if "checkpoint_id" in payload.model_fields_set:
        await set_checkpoint_assignment(db, "browser:" + user_id, payload.checkpoint_id, actor["sub"])
        await db.commit()
        await publish_checkpoint_assignment("browser:" + user_id)
    assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id, populate_existing=True)
    return _user_summary((await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json(),
        await _user_roles(token, user_id), assignment.checkpoint_id if assignment else None)


@router.put("/users/{user_id}/roles")
async def replace_user_roles(user_id: str, payload: RolesRequest, token: str = Depends(_admin_context)) -> dict[str, Any]:
    return {"roles": await _replace_roles(token, user_id, payload.roles)}


@router.put("/users/{user_id}/password")
async def reset_password(user_id: str, payload: PasswordResetRequest, token: str = Depends(_admin_context)) -> dict[str, bool]:
    await _request(token, "PUT", f"users/{quote(user_id, safe='')}/reset-password", {
        "type": "password", "value": payload.password, "temporary": payload.temporary,
    })
    return {"updated": True}


@router.post("/users/{user_id}/logout")
async def end_user_sessions(user_id: str, token: str = Depends(_admin_context)) -> dict[str, bool]:
    await _request(token, "POST", f"users/{quote(user_id, safe='')}/logout")
    return {"ended": True}
