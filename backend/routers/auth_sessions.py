"""Current application session revocation."""
from fastapi import APIRouter, Depends, Response

from auth import verify_authenticated_request
from config import settings
from token_revocation import revoke_token

router = APIRouter(prefix="/v1/auth", tags=["authentication"])


@router.post("/revoke-session", status_code=204)
async def revoke_current_session(
    claims: dict = Depends(verify_authenticated_request),
):
    """Make the current bearer unusable immediately in this application."""
    await revoke_token(settings.KEYCLOAK_ISSUER, claims["sub"], claims["jti"], claims["exp"])
    return Response(status_code=204)
