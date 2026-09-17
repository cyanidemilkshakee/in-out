"""Per-identity profile preferences. Keycloak owns accounts and credentials."""
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from database import get_db
from models import AdminAccount

router = APIRouter(prefix="/v1/admin", tags=["admin"])


class ProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True, extra="forbid")
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    nickname: Optional[str] = Field(None, min_length=1, max_length=100)
    email: Optional[str] = Field(None, min_length=3, max_length=320, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    avatar_data_url: Optional[str] = Field(None, alias="avatarDataUrl", max_length=3_000_000)
    auto_lock: Optional[str] = Field(None, alias="autoLock", pattern="^(5|10|15|30|60|never)$")
    settings: Optional[dict[str, bool]] = None


def _serialize_account(account):
    return {"id": account.id, "name": account.name, "nickname": account.nickname,
        "email": account.email, "avatar_data_url": account.avatar_data_url,
        "auto_lock": account.auto_lock, "settings": account.settings or {},
        "is_current": True, "created_at": account.created_at.isoformat()}


async def _identity_profile(db, admin):
    subject = admin["sub"]
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("profile:" + subject, 0))))
    account = await db.scalar(select(AdminAccount).where(AdminAccount.keycloak_subject == subject).with_for_update())
    if account:
        return account
    # Preserve legacy preferences only when Keycloak verifies the matching email.
    email = admin.get("email")
    if email and admin.get("email_verified") is True:
        account = await db.scalar(select(AdminAccount).where(AdminAccount.keycloak_subject.is_(None),
            func.lower(AdminAccount.email) == email.lower()).order_by(AdminAccount.created_at).limit(1).with_for_update())
    if account:
        account.keycloak_subject = subject
    else:
        account = AdminAccount(id=str(uuid.uuid4()), keycloak_subject=subject,
            name=admin.get("name") or admin.get("preferred_username") or "Administrator",
            nickname=admin.get("preferred_username") or "admin", email=email or "",
            avatar_data_url="", auto_lock="15", settings={"syncAlerts": True, "weeklyDigest": False, "requireReviewNote": True},
            is_current=False, created_at=datetime.now(timezone.utc))
        db.add(account)
    await db.flush()
    return account


@router.get("/profile")
async def get_admin_profile(db: AsyncSession = Depends(get_db), admin: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    account = await _identity_profile(db, admin)
    await db.commit()
    return _serialize_account(account)


@router.patch("/profile")
async def update_admin_profile(payload: ProfileUpdateRequest, db: AsyncSession = Depends(get_db),
                               admin: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    account = await _identity_profile(db, admin)
    for key, value in payload.model_dump(exclude_none=True).items():
        setattr(account, key, value)
    await db.commit()
    return _serialize_account(account)


@router.post("/profile/accounts")
async def create_admin_account(_admin: dict = Depends(verify_admin_request)):
    raise HTTPException(409, "Create administrators in Keycloak and assign the admin role. Each identity has its own profile.")
