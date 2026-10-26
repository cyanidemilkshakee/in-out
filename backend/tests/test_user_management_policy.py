import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from user_management_policy import can_manage_user, can_update_user_fields


class UserManagementPolicyTests(unittest.TestCase):
    def test_master_admin_manages_admin_and_operator_but_not_master_admin(self):
        self.assertTrue(can_manage_user(True, ["admin"]))
        self.assertTrue(can_manage_user(True, ["operator"]))
        self.assertFalse(can_manage_user(True, ["master-admin", "admin"]))
        self.assertFalse(can_manage_user(True, []))

    def test_regular_admin_manages_only_operator_access_fields(self):
        self.assertTrue(can_manage_user(False, ["operator"]))
        self.assertFalse(can_manage_user(False, ["admin"]))
        self.assertFalse(can_manage_user(False, ["operator", "admin"]))
        self.assertTrue(can_update_user_fields(False, ["operator"], {"enabled", "checkpoint_id"}))
        self.assertFalse(can_update_user_fields(False, ["operator"], {"first_name"}))
        self.assertFalse(can_update_user_fields(False, ["operator"], {"roles"}))

    def test_master_admin_can_change_managed_identity_fields_and_roles(self):
        self.assertTrue(can_update_user_fields(True, ["admin"], {"first_name", "roles", "checkpoint_id"}))
        self.assertTrue(can_update_user_fields(True, ["operator"], {"enabled"}))
        self.assertFalse(can_update_user_fields(True, ["master-admin"], {"enabled"}))


if __name__ == "__main__":
    unittest.main()
