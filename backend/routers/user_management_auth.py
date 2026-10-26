"""Reauthentication-window state is protected by identity and a BFF proof."""
from typing import Annotated
from fastapi import APIRouter, Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from auth import verify_admin_request
from database import get_db
from data_limits import precharge_mutation_response
from user_management_step_up import verified_user_management_window
from user_management_locks import lock_window, window_is_locked

router = APIRouter(prefix="/v1/user-management", tags=["authentication"])
_bearer = HTTPBearer(auto_error=False)


def _window(credentials, claims, proof):
    return verified_user_management_window(credentials.credentials, claims, proof)


@router.get("/window")
async def window_state(
    claims: dict = Depends(verify_admin_request),
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    proof: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
    db: AsyncSession = Depends(get_db),
):
    window = _window(credentials, claims, proof)
    unlocked = not await window_is_locked(db, claims, window)
    return {"unlocked": unlocked, "expiresAt": window["expiresAt"] if unlocked else None}


@router.post("/lock")
async def revoke_window(
    claims: dict = Depends(verify_admin_request),
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    proof: Annotated[str | None, Header(alias="X-InOut-Step-Up")] = None,
    db: AsyncSession = Depends(get_db),
):
    response = {"locked": True}
    await precharge_mutation_response(db, response)
    await lock_window(db, claims, _window(credentials, claims, proof))
    return response
