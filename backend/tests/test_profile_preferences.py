"""Profile preference writes preserve identity email, including email-less admins."""
import unittest

import test_database as fixture
from auth import verify_admin_request


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class ProfilePreferenceTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def test_email_less_admin_can_save_name_nickname_and_avatar(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "no-email-admin", "preferred_username": "ops",
            "realm_access": {"roles": ["admin"]},
        }
        loaded = await self.client.get("/v1/admin/profile")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json()["email"], "")
        saved = await self.client.patch("/v1/admin/profile", json={
            "name": "Operations Admin", "nickname": "operations",
            "avatarDataUrl": "data:image/png;base64,dGVzdA==",
            "settings": {"requireReviewNote": True},
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["email"], "")
        self.assertEqual(saved.json()["name"], "Operations Admin")
        reloaded = await self.client.get("/v1/admin/profile")
        self.assertEqual(reloaded.json()["nickname"], "operations")
        self.assertEqual(reloaded.json()["avatar_data_url"], "data:image/png;base64,dGVzdA==")

    async def test_preferences_do_not_replace_existing_identity_email(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "email-admin", "preferred_username": "ops", "email": "admin@example.test",
            "realm_access": {"roles": ["admin"]},
        }
        await self.client.get("/v1/admin/profile")
        saved = await self.client.patch("/v1/admin/profile", json={
            "name": "New Name", "nickname": "new-name", "avatarDataUrl": "",
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["email"], "admin@example.test")
