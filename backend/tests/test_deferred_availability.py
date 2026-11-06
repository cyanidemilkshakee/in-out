"""A delayed post-sign-in reset must not undo a newer explicit sign-out."""
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from routers import admin_profile


class DeferredAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.account = SimpleNamespace(offline_until=None, settings={"requireReviewNote": True})
        self.db = SimpleNamespace(info={}, commit=AsyncMock())
        self.identity = patch.object(admin_profile, "_identity_profile", AsyncMock(return_value=self.account))
        self.enqueue = patch.object(admin_profile, "enqueue_changed", AsyncMock())
        self.identity.start()
        self.changed = self.enqueue.start()
        self.addCleanup(self.identity.stop)
        self.addCleanup(self.enqueue.stop)

    async def update(self, **values):
        return await admin_profile.update_admin_availability(
            admin_profile.AvailabilityUpdateRequest(**values), self.db, {"sub": "synthetic-admin"})

    async def test_delayed_signin_clear_preserves_a_newer_explicit_offline_time(self):
        signed_in = datetime.now(timezone.utc) - timedelta(seconds=1)
        expected_return = datetime.now(timezone.utc) + timedelta(minutes=30)
        await self.update(offlineUntil=expected_return)
        self.changed.reset_mock()
        result = await self.update(offlineUntil=None, clearBefore=signed_in)
        self.assertEqual(self.account.offline_until, expected_return)
        self.assertEqual(result["offline_until"], expected_return.isoformat())
        self.changed.assert_not_awaited()

    async def test_current_signin_clears_old_offline_state_once(self):
        self.account.offline_until = datetime.now(timezone.utc) + timedelta(minutes=30)
        self.account.settings["_availabilityChangedAt"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        await self.update(offlineUntil=None, clearBefore=datetime.now(timezone.utc))
        self.assertIsNone(self.account.offline_until)
        self.changed.assert_awaited_once()
        self.changed.reset_mock()
        await self.update(offlineUntil=None, clearBefore=datetime.now(timezone.utc))
        self.changed.assert_not_awaited()

    async def test_reaffirming_the_same_offline_time_still_protects_against_older_resets(self):
        self.account.offline_until = datetime.now(timezone.utc) + timedelta(minutes=30)
        signed_in = datetime.now(timezone.utc) - timedelta(seconds=1)
        await self.update(offlineUntil=self.account.offline_until)
        await self.update(offlineUntil=None, clearBefore=signed_in)
        self.assertIsNotNone(self.account.offline_until)

    async def test_reset_marker_rejects_naive_future_and_offline_combinations(self):
        for values in (
            {"clearBefore": datetime.now()},
            {"clearBefore": datetime.now(timezone.utc) + timedelta(minutes=2)},
            {"clearBefore": datetime.now(timezone.utc), "offlineUntil": datetime.now(timezone.utc) + timedelta(minutes=10)},
        ):
            with self.subTest(values=values), self.assertRaises(HTTPException) as failure:
                await self.update(**values)
            self.assertEqual(failure.exception.status_code, 422)

    def test_private_availability_order_survives_settings_normalization_but_is_not_a_user_preference(self):
        marker = datetime.now(timezone.utc).isoformat()
        settings = {"requireReviewNote": False, "_availabilityChangedAt": marker}
        self.assertEqual(admin_profile._stored_settings(settings), {"requireReviewNote": True, "_availabilityChangedAt": marker})
        self.assertEqual(admin_profile._review_note_policy(settings), {"requireReviewNote": True})

    async def test_editing_profile_preferences_preserves_private_order_and_public_settings(self):
        marker = datetime.now(timezone.utc).isoformat()
        self.account.settings["_availabilityChangedAt"] = marker
        for key, value in {"id": "profile-a", "name": "Synthetic admin", "nickname": "admin",
                           "email": "synthetic@example.invalid", "avatar_data_url": "",
                           "created_at": datetime.now(timezone.utc)}.items():
            setattr(self.account, key, value)
        result = await admin_profile.update_admin_profile(
            admin_profile.ProfileUpdateRequest(settings={"requireReviewNote": False}), self.db, {"sub": "synthetic-admin"})
        self.assertEqual(self.account.settings["_availabilityChangedAt"], marker)
        self.assertEqual(result["settings"], {"requireReviewNote": True})


if __name__ == "__main__":
    unittest.main()
