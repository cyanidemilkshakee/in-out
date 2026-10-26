"""Authoritative per-window locks for administrator identity management."""
from datetime import datetime, timezone
import time
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from models import UserManagementWindowLock
from database import AsyncSessionLocal


async def get_window_guard_db():
    # Account provisioning commits/rolls back its assignment transaction before
    # provider provisioning or compensation ends. Its authorization guard must
    # therefore have a separate primary transaction lasting the entire request.
    async with AsyncSessionLocal() as db:
        yield db


def _subject(claims):
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(401, "A verified administrator identity is required")
    return subject


async def window_is_locked(db, claims, window):
    return await db.scalar(select(UserManagementWindowLock.window_id).where(
        UserManagementWindowLock.keycloak_subject == _subject(claims),
        UserManagementWindowLock.window_id == window["windowId"],
    )) is not None


async def require_unlocked_window(db, claims, window):
    # Serialize Lock with already admitted management commands. The shared
    # get_db transaction holds this until the command completes or rolls back.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:window, 0))"), {
        "window": "user-management:" + _subject(claims) + ":" + window["windowId"],
    })
    if time.time() >= window["expiresAt"]:
        raise HTTPException(401, "Step-up authentication expired while waiting; re-authenticate")
    if await window_is_locked(db, claims, window):
        raise HTTPException(403, "Fresh re-authentication is required to manage users")


async def lock_window(db, claims, window):
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:window, 0))"), {
        "window": "user-management:" + _subject(claims) + ":" + window["windowId"],
    })
    await db.execute(insert(UserManagementWindowLock).values(
        keycloak_subject=_subject(claims), window_id=window["windowId"],
        expires_at=datetime.fromtimestamp(window["expiresAt"], timezone.utc),
    ).on_conflict_do_nothing())
    await db.commit()
