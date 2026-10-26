"""Application revocation blocks signed tokens immediately across API workers."""
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import Depends, FastAPI
import httpx

import auth
import token_revocation


class TokenRevocationTests(unittest.IsolatedAsyncioTestCase):
    async def test_principal_cutoff_rejects_existing_signed_token(self):
        claims = {"sub": "account-1", "jti": "token-1", "iat": 100, "exp": 200}
        redis = AsyncMock()
        redis.mget.return_value = ("100", None)
        with patch("token_revocation.get_redis_pool", return_value=redis):
            with self.assertRaises(auth.HTTPException) as raised:
                await token_revocation.assert_token_active(claims)
        self.assertEqual(raised.exception.status_code, 401)

    async def test_token_id_revocation_is_scoped_and_written_through_redis(self):
        redis = AsyncMock()
        issuer = "https://identity.test/realms/inout"
        with patch("token_revocation.get_redis_pool", return_value=redis), \
             patch("token_revocation.time.time", return_value=100):
            await token_revocation.revoke_token(issuer, "account-1", "token-1", 160)
        redis.set.assert_awaited_once()
        key, value = redis.set.await_args.args
        self.assertNotIn(issuer, key)  # Redis keys retain only the issuer/subject digest.
        self.assertEqual(value, "1")
        self.assertEqual(redis.set.await_args.kwargs["ex"], 60)

    async def test_verified_request_checks_revocation_before_admitting_route(self):
        app = FastAPI()

        @app.get("/protected")
        async def protected(_claims=Depends(auth.verify_authenticated_request)):
            return {"ok": True}

        claims = {"sub": "account-1", "jti": "token-1", "iat": 100,
            "exp": time.time() + 300, "_inout_verified_access_token": True}
        redis = AsyncMock()
        redis.mget.return_value = ("100", None)
        with patch("auth.verify_keycloak_token", return_value=claims), \
             patch("token_revocation.get_redis_pool", return_value=redis):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://isolated") as client:
                response = await client.get("/protected", headers={"Authorization": "Bearer signed-token"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(redis.mget.await_count, 1)


if __name__ == "__main__":
    unittest.main()
