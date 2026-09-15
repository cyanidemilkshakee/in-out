"""
Admin profile endpoints.

GET  /v1/admin/profile           — fetch current admin account (auth-protected)
PATCH /v1/admin/profile          — update profile / change password (auth-protected)
POST /v1/admin/profile/accounts  — create new admin account (auth-protected)
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_db
from models import AdminAccount

router = APIRouter(prefix="/v1/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class ProfileUpdateRequest(BaseModel):
    name: Optional[str] = None
    nickname: Optional[str] = None
    email: Optional[str] = None
    avatar_data_url: Optional[str] = None
    auto_lock: Optional[str] = None
    settings: Optional[dict[str, Any]] = None


class NewAccountRequest(BaseModel):
    name: str
    nickname: str
    email: str
    avatar_data_url: Optional[str] = ""
    auto_lock: Optional[str] = "15"
    settings: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _serialize_account(acc: AdminAccount) -> dict[str, Any]:
    """Return profile fields. Keycloak owns login credentials."""
    return {
        "id":              acc.id,
        "name":            acc.name,
        "nickname":        acc.nickname,
        "email":           acc.email,
        "avatar_data_url": acc.avatar_data_url,
        "auto_lock":       acc.auto_lock,
        "settings":        acc.settings or {},
        "is_current":      acc.is_current,
        "created_at":      acc.created_at.isoformat() if acc.created_at else None,
    }


# ---------------------------------------------------------------------------
# GET /v1/admin/profile
# ---------------------------------------------------------------------------

@router.get("/profile")
async def get_admin_profile(
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Fetch the currently active admin account."""
    result = await db.execute(
        select(AdminAccount).where(AdminAccount.is_current.is_(True))
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="No current admin account found")
    return _serialize_account(account)


# ---------------------------------------------------------------------------
# PATCH /v1/admin/profile
# ---------------------------------------------------------------------------

@router.patch("/profile")
async def update_admin_profile(
    payload: ProfileUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Update the current admin profile preferences.
    """
    result = await db.execute(
        select(AdminAccount).where(AdminAccount.is_current.is_(True))
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="No current admin account found")

    # Apply field updates
    if payload.name is not None:
        account.name = payload.name
    if payload.nickname is not None:
        account.nickname = payload.nickname
    if payload.email is not None:
        account.email = payload.email
    if payload.avatar_data_url is not None:
        account.avatar_data_url = payload.avatar_data_url
    if payload.auto_lock is not None:
        account.auto_lock = payload.auto_lock
    if payload.settings is not None:
        account.settings = payload.settings

    await db.commit()
    await db.refresh(account)
    return _serialize_account(account)


# ---------------------------------------------------------------------------
# POST /v1/admin/profile/accounts
# ---------------------------------------------------------------------------

@router.post("/profile/accounts")
async def create_admin_account(
    payload: NewAccountRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Create a new admin account.
    - Validates email uniqueness.
    - Sets all existing accounts'' is_current=False, new account is_current=True.
    """
    # Check email uniqueness
    existing = await db.execute(
        select(AdminAccount).where(AdminAccount.email == payload.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    # Demote all existing current accounts
    await db.execute(
        update(AdminAccount).where(AdminAccount.is_current.is_(True)).values(is_current=False)
    )

    new_account = AdminAccount(
        id=str(uuid.uuid4()),
        name=payload.name,
        nickname=payload.nickname,
        email=payload.email,
        avatar_data_url=payload.avatar_data_url or "",
        auto_lock=payload.auto_lock or "15",
        settings=payload.settings or {},
        is_current=True,
        created_at=datetime.now(timezone.utc),
    )
    db.add(new_account)
    await db.commit()
    await db.refresh(new_account)
    return _serialize_account(new_account)
