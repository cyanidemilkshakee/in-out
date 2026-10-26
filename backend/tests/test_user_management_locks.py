"""Persistent revocations against isolated PostgreSQL and a stub provider."""
import asyncio
import hashlib
import os
import time
import unittest
import uuid
import httpx
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from auth import verify_admin_request
from config import settings
from routers import keycloak_admin, user_management_auth
from user_management_locks import get_window_guard_db, lock_window, require_unlocked_window, window_is_locked
from tests import test_database as fixture
from tests.test_user_management_step_up import proof_for, SECRET


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Requires the isolated PostgreSQL test database")
class UserManagementLockTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def window(self, window_id=None):
        now = int(time.time())
        return {"issuedAt": now, "authTime": now-1, "expiresAt": now+599,
            "durationMinutes": 10, "tokenHash": hashlib.sha256(b"synthetic-bearer").hexdigest(),
            "windowId": window_id or str(uuid.uuid4())}

    async def test_revocation_survives_new_sessions_replay_and_is_bound_to_identity_and_window(self):
        window = self.window()
        async with self.sessions() as db:
            await lock_window(db, {"sub": "admin-a"}, window)
        # This is a separate database session, not client cookie state or memory.
        async with self.sessions() as db:
            self.assertTrue(await window_is_locked(db, {"sub": "admin-a"}, window))
            self.assertFalse(await window_is_locked(db, {"sub": "admin-b"}, window))
            self.assertFalse(await window_is_locked(db, {"sub": "admin-a"}, self.window()))
            with self.assertRaises(HTTPException) as rejected:
                await require_unlocked_window(db, {"sub": "admin-a"}, window)
            self.assertEqual(rejected.exception.status_code, 403)
        async with self.sessions() as db:
            await lock_window(db, {"sub": "admin-a"}, window)  # Idempotent retry.

    async def test_http_lock_prevents_management_even_with_replayed_signed_proof_and_refreshed_bearer(self):
        claims = {"sub": "admin-a", "realm_access": {"roles": ["admin"]}}
        self.app.include_router(user_management_auth.router)
        self.app.include_router(keycloak_admin.router)
        async def guard_session():
            async with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_window_guard_db] = guard_session
        self.app.dependency_overrides[verify_admin_request] = lambda: claims
        window = self.window()
        headers = {"Authorization": "Bearer synthetic-bearer", "X-InOut-Step-Up": proof_for(window)}
        with patch.object(settings, "KEYCLOAK_STEP_UP_SIGNING_SECRET", SECRET), \
             patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(return_value=claims)), \
             patch("routers.keycloak_admin._request", new=AsyncMock()) as provider:
            before = await self.client.get("/v1/user-management/window", headers=headers)
            self.assertEqual(before.status_code, 200, before.text)
            self.assertTrue(before.json()["unlocked"])
            locked = await self.client.post("/v1/user-management/lock", headers=headers, json={})
            self.assertEqual(locked.status_code, 200, locked.text)
            after = await self.client.get("/v1/user-management/window", headers=headers)
            self.assertFalse(after.json()["unlocked"])
            rejected = await self.client.get("/v1/keycloak/users", headers=headers)
            self.assertEqual(rejected.status_code, 403, rejected.text)
            renewed = {**window, "tokenHash": hashlib.sha256(b"refreshed-bearer").hexdigest()}
            replay = await self.client.post("/v1/keycloak/users", json={"username": "blocked", "password": "test-only-password", "roles": ["operator"]},
                headers={"Authorization": "Bearer refreshed-bearer", "X-InOut-Step-Up": proof_for(renewed)})
            self.assertEqual(replay.status_code, 403, replay.text)
            bare = await self.client.get("/v1/keycloak/users", headers={"Authorization": "Bearer synthetic-bearer"})
            self.assertEqual(bare.status_code, 401)
            provider.assert_not_awaited()

    async def test_lock_waits_for_an_admitted_command_then_blocks_subsequent_commands(self):
        window = self.window()
        claims = {"sub": "admin-a"}
        async with self.sessions() as admitted:
            await require_unlocked_window(admitted, claims, window)
            async def lock_later():
                async with self.sessions() as db:
                    await lock_window(db, claims, window)
            locking = asyncio.create_task(lock_later())
            await asyncio.sleep(0.05)
            self.assertFalse(locking.done())
            await admitted.commit()
            await asyncio.wait_for(locking, 3)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException):
                await require_unlocked_window(db, claims, window)

    async def test_queued_command_must_recheck_expiry_after_guard_acquisition(self):
        window = {**self.window(), "expiresAt": int(time.time()) + 1}
        claims = {"sub": "admin-a"}
        async with self.sessions() as blocker:
            await require_unlocked_window(blocker, claims, window)
            async def queued():
                async with self.sessions() as db:
                    await require_unlocked_window(db, claims, window)
            waiting = asyncio.create_task(queued())
            await asyncio.sleep(max(0.05, window["expiresAt"] - time.time() + 0.02))
            await blocker.commit()
            with self.assertRaises(HTTPException) as rejected:
                await asyncio.wait_for(waiting, 3)
            self.assertEqual(rejected.exception.status_code, 401)

    async def test_lock_waits_through_create_users_early_assignment_commit(self):
        claims = {"sub": "admin-a", "realm_access": {"roles": ["admin"]}}
        self.app.include_router(user_management_auth.router)
        self.app.include_router(keycloak_admin.router)
        self.app.dependency_overrides[verify_admin_request] = lambda: claims
        async def guard_session():
            async with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_window_guard_db] = guard_session
        entered, resume = asyncio.Event(), asyncio.Event()
        async def roles(*args):
            entered.set()
            await resume.wait()
            return ["operator"]
        async def provider(token, method, path, payload=None):
            if method == "POST":
                return httpx.Response(201, headers={"Location": "http://synthetic/users/new-operator"})
            return httpx.Response(200, json={"id": "new-operator", "username": "new-operator", "enabled": True})
        headers = {"Authorization": "Bearer synthetic-bearer", "X-InOut-Step-Up": proof_for(self.window())}
        with patch.object(settings, "KEYCLOAK_STEP_UP_SIGNING_SECRET", SECRET), \
             patch("routers.keycloak_admin.verify_admin_request", new=AsyncMock(return_value=claims)), \
             patch("routers.keycloak_admin._request", side_effect=provider), \
             patch("routers.keycloak_admin._replace_roles", side_effect=roles), \
             patch("routers.keycloak_admin.publish_checkpoint_assignment", new=AsyncMock()):
            creating = asyncio.create_task(self.client.post("/v1/keycloak/users", headers=headers, json={
                "username": "new-operator", "password": "test-only-password", "roles": ["operator"], "checkpointId": "cp-main"}))
            locking = None
            try:
                await asyncio.wait_for(entered.wait(), 3)
                locking = asyncio.create_task(self.client.post("/v1/user-management/lock", headers=headers, json={}))
                await asyncio.sleep(0.05)
                self.assertFalse(locking.done(), "Assignment commit must not release the full-request authorization guard")
            finally:
                resume.set()
                created = await asyncio.wait_for(creating, 5)
                if locking is not None:
                    locked = await asyncio.wait_for(locking, 5)
            self.assertEqual(created.status_code, 201, created.text)
            self.assertEqual(locked.status_code, 200, locked.text)


if __name__ == "__main__":
    unittest.main()
