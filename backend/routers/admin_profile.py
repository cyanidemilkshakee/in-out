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
from redis_client import publish_data_changed

router = APIRouter(prefix="/v1/admin", tags=["admin"])


class ProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True, extra="forbid")
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    nickname: Optional[str] = Field(None, min_length=1, max_length=100)
    email: Optional[str] = Field(None, min_length=3, max_length=320, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    avatar_data_url: Optional[str] = Field(None, alias="avatarDataUrl", max_length=3_000_000)
    settings: Optional[dict[str, bool]] = None


class AvailabilityUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    offline_until: Optional[datetime] = Field(None, alias="offlineUntil")


def _review_note_policy(_settings: Optional[dict[str, bool]]) -> dict[str, bool]:
    """Review decisions are auditable security actions, so the policy is always on."""
    return {"requireReviewNote": True}


def _serialize_account(account):
    return {"id": account.id, "name": account.name, "nickname": account.nickname,
        "email": account.email, "avatar_data_url": account.avatar_data_url,
        "offline_until": account.offline_until.isoformat() if account.offline_until else None,
        "settings": _review_note_policy(account.settings),
        "created_at": account.created_at.isoformat()}


async def _identity_profile(db, admin):
    subject = admin["sub"]
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("profile:" + subject, 0))))
    account = await db.scalar(select(AdminAccount).where(AdminAccount.keycloak_subject == subject).with_for_update())
    if account:
        account.settings = _review_note_policy(account.settings)
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
            avatar_data_url="", settings=_review_note_policy(None),
            created_at=datetime.now(timezone.utc))
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
    updates = payload.model_dump(exclude_none=True)
    for key, value in updates.items():
        if key == "settings":
            value = _review_note_policy(value)
        setattr(account, key, value)
    await db.commit()
    await publish_data_changed()
    return _serialize_account(account)


@router.patch("/profile/availability")
async def update_admin_availability(payload: AvailabilityUpdateRequest, db: AsyncSession = Depends(get_db),
                                    admin: dict = Depends(verify_admin_request)) -> dict[str, Any]:
    """Record an explicit, short-lived expected admin return time after SSO logout."""
    offline_until = payload.offline_until
    if offline_until:
        if offline_until.tzinfo is None:
            raise HTTPException(status_code=422, detail="offlineUntil must include a timezone")
        seconds = (offline_until - datetime.now(timezone.utc)).total_seconds()
        if seconds < 60 or seconds > 24 * 60 * 60:
            raise HTTPException(status_code=422, detail="offlineUntil must be between one minute and 24 hours from now")
    account = await _identity_profile(db, admin)
    account.offline_until = offline_until
    await db.commit()
    await publish_data_changed()
    return {"offline_until": account.offline_until.isoformat() if account.offline_until else None}
