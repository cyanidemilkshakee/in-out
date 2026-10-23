import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from user_management_policy import can_manage_user, can_update_user_fields


class UserManagementPolicyTests(unittest.TestCase):
    def test_admin_can_manage_supported_application_accounts(self):
        self.assertTrue(can_manage_user(True, ["admin"]))
        self.assertTrue(can_manage_user(True, ["operator"]))
        self.assertFalse(can_manage_user(True, []))
        self.assertFalse(can_manage_user(False, ["operator"]))

    def test_admin_can_update_profile_access_roles_and_checkpoint(self):
        self.assertTrue(can_update_user_fields(True, ["admin"], {"first_name", "roles"}))
        self.assertTrue(can_update_user_fields(True, ["operator"], {"enabled", "checkpoint_id"}))
        self.assertFalse(can_update_user_fields(False, ["operator"], {"enabled"}))


if __name__ == "__main__":
    unittest.main()
