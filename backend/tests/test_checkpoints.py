"""Zone-scoped checkpoint creation is bounded, audited, and step-up protected."""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request

from access_validation import require_registered_checkpoint
from models import AuditEvent, Checkpoint, OrganizationZone
from routers import checkpoints


def request_context():
    return Request({"type": "http", "method": "POST", "scheme": "http",
        "server": ("test", 80), "client": ("test", 1), "headers": [], "query_string": b""})


class CheckpointCreationTests(unittest.IsolatedAsyncioTestCase):
    async def test_custom_checkpoint_uses_next_zone_number_and_audits_zone(self):
        zone = OrganizationZone(id="a", name="A", active=True)
        db = Mock(get=AsyncMock(return_value=None), execute=AsyncMock(),
            scalar=AsyncMock(side_effect=[2, None]), add=Mock(), flush=AsyncMock(),
            commit=AsyncMock(), rollback=AsyncMock())
        actor = {"sub": "admin-a", "realm_access": {"roles": ["admin"]}}
        with patch("routers.checkpoints.require_zone_scope", new=AsyncMock(return_value=zone)), \
             patch("routers.checkpoints.enqueue_changed", new=AsyncMock(return_value=12)) as enqueue:
            result = await checkpoints.create_checkpoint(
                checkpoints.CheckpointCreate(zoneId="a", name="Loading Bay", preset="custom"), db, actor)

        self.assertEqual((result["id"], result["zoneId"], result["number"]), ("a-3", "a", 3))
        self.assertEqual(result["name"], "Loading Bay")
        added = [call.args[0] for call in db.add.call_args_list]
        self.assertIsInstance(added[0], Checkpoint)
        self.assertIsInstance(added[1], AuditEvent)
        self.assertEqual(added[1].data["zoneId"], "a")
        self.assertEqual(added[1].data["action"], "checkpoint_created")
        enqueue.assert_awaited_once_with(db)
        db.commit.assert_awaited_once()
        db.rollback.assert_not_awaited()

    async def test_active_back_gate_is_not_duplicated_and_limit_is_enforced(self):
        zone = OrganizationZone(id="a", name="A", active=True)
        active_back_gate = Checkpoint(id="a-2", zone_id="a", number=2,
            gate_type="back_gate", required=False, active=True, data={"name": "2"})
        duplicate_db = Mock(execute=AsyncMock(), scalar=AsyncMock(side_effect=[2, active_back_gate]),
            add=Mock(), rollback=AsyncMock())
        with patch("routers.checkpoints.require_zone_scope", new=AsyncMock(return_value=zone)):
            with self.assertRaises(HTTPException) as duplicate:
                await checkpoints.create_checkpoint(
                    checkpoints.CheckpointCreate(zoneId="a", preset="back_gate"), duplicate_db,
                    {"sub": "admin-a", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(duplicate.exception.status_code, 409)
        duplicate_db.add.assert_not_called()
        duplicate_db.rollback.assert_awaited_once()

        full_db = Mock(execute=AsyncMock(), scalar=AsyncMock(return_value=checkpoints._MAX_CHECKPOINTS_PER_ZONE),
            add=Mock(), rollback=AsyncMock())
        with patch("routers.checkpoints.require_zone_scope", new=AsyncMock(return_value=zone)):
            with self.assertRaises(HTTPException) as full:
                await checkpoints.create_checkpoint(
                    checkpoints.CheckpointCreate(zoneId="a", name="Another Gate"), full_db,
                    {"sub": "admin-a", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(full.exception.status_code, 409)
        full_db.add.assert_not_called()
        full_db.rollback.assert_awaited_once()

    async def test_registered_checkpoint_requires_active_registered_zone(self):
        active_zone = OrganizationZone(id="a", name="A", active=True)
        dynamic = Checkpoint(id="a-3", zone_id="a", number=3,
            gate_type="custom", required=False, active=True, data={"name": "Loading Bay"})
        db = Mock(get=AsyncMock(side_effect=lambda model, identity:
            dynamic if model is Checkpoint and identity == "a-3" else None),
            scalar=AsyncMock(return_value=active_zone))
        self.assertEqual(await require_registered_checkpoint(db, "a-3"), "a-3")
        db.get.return_value = None
        with self.assertRaises(HTTPException) as unknown:
            await require_registered_checkpoint(db, "a-4")
        self.assertEqual(unknown.exception.status_code, 422)
        db.get.side_effect = lambda model, identity: dynamic if model is Checkpoint and identity == "a-3" else None
        db.scalar.return_value = OrganizationZone(id="a", name="A", active=False)
        with self.assertRaises(HTTPException) as retired_zone:
            await require_registered_checkpoint(db, "a-3")
        self.assertEqual(retired_zone.exception.status_code, 422)
        with self.assertRaises(HTTPException):
            await require_registered_checkpoint(db, "../checkpoint")

    async def test_checkpoint_write_context_requires_admin_and_fresh_step_up(self):
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="synthetic-token")
        guard_db = Mock()
        operator = {"sub": "operator", "realm_access": {"roles": ["operator"]}}
        with patch("routers.checkpoints.verify_admin_request", new=AsyncMock(return_value=operator)) as verify, \
             patch("routers.checkpoints.verified_user_management_window") as step_up:
            with self.assertRaises(HTTPException) as denied:
                await checkpoints._checkpoint_admin_context(request_context(), credentials, "proof", guard_db)
            self.assertEqual(denied.exception.status_code, 403)
            verify.assert_awaited_once()
            step_up.assert_not_called()

        master_admin = {"sub": "master", "realm_access": {"roles": ["master-admin", "admin"]}}
        window = {"windowId": "synthetic-window", "expiresAt": 1_900_000_000}
        with patch("routers.checkpoints.verify_admin_request", new=AsyncMock(return_value=master_admin)), \
             patch("routers.checkpoints.verified_user_management_window", return_value=window) as step_up, \
             patch("routers.checkpoints.require_unlocked_window", new=AsyncMock()) as require_unlocked:
            result = await checkpoints._checkpoint_admin_context(request_context(), credentials, "proof", guard_db)
        self.assertIs(result, master_admin)
        step_up.assert_called_once_with("synthetic-token", master_admin, "proof", now=unittest.mock.ANY)
        require_unlocked.assert_awaited_once_with(guard_db, master_admin, window)


if __name__ == "__main__":
    unittest.main()
