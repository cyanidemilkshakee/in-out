"""Application-scoped Keycloak user administration.

Keycloak remains the identity authority.  This router exposes only the user
and role operations the InOut dashboard needs and forwards the signed-in
administrator's bearer token to Keycloak's Admin REST API.  It never stores a
master-admin password and deliberately has no delete-user endpoint.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal
import math
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from auth import verify_admin_request
from config import settings

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
) -> str:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Bearer token required")
    claims = await verify_admin_request(credentials)
    auth_time = claims.get("auth_time")
    if (isinstance(auth_time, bool) or not isinstance(auth_time, (int, float)) or
        not math.isfinite(auth_time) or not -30 <= time.time() - auth_time <= settings.KEYCLOAK_STEP_UP_MAX_AGE_SECONDS):
        raise HTTPException(status_code=401, detail="Step-up authentication required before managing users")
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


def _user_summary(user: dict[str, Any], roles: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": user.get("id"),
        "username": user.get("username", ""),
        "firstName": user.get("firstName", ""),
        "lastName": user.get("lastName", ""),
        "email": user.get("email", ""),
        "enabled": bool(user.get("enabled", False)),
        "emailVerified": bool(user.get("emailVerified", False)),
        "createdTimestamp": user.get("createdTimestamp"),
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
) -> dict[str, Any]:
    query = f"users?briefRepresentation=true&first={first}&max={max_results}"
    if search.strip():
        query += f"&search={quote(search.strip(), safe='')}"
    users = (await _request(token, "GET", query)).json()
    return {"items": [_user_summary(user) for user in users if isinstance(user, dict)], "first": first, "max": max_results}


@router.get("/users/{user_id}")
async def get_user(user_id: str, token: str = Depends(_admin_context)) -> dict[str, Any]:
    user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    return _user_summary(user, await _user_roles(token, user_id))


@router.post("/users", status_code=201)
async def create_user(payload: UserCreateRequest, token: str = Depends(_admin_context)) -> dict[str, Any]:
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
    roles = await _replace_roles(token, user_id, payload.roles)
    user = (await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json()
    return _user_summary(user, roles)


@router.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UserUpdateRequest, token: str = Depends(_admin_context)) -> dict[str, Any]:
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
    return _user_summary((await _request(token, "GET", f"users/{quote(user_id, safe='')}")).json(), await _user_roles(token, user_id))


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
