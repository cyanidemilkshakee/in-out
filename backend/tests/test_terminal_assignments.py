"""Account administration and physical terminals cannot bypass checkpoint binding."""
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, HTTPException
from database import get_db
from models import AuditEvent, TerminalCheckpointAssignment
from routers import keycloak_admin
from main import process_scan
from schemas import ScanPayload


class TerminalAssignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_operator_and_admin_without_step_up_cannot_change_assignments(self):
        app = FastAPI()
        app.include_router(keycloak_admin.router)
        db = Mock(execute=AsyncMock(), commit=AsyncMock())
        app.dependency_overrides[get_db] = lambda: db
        for roles, auth_time, expected in ((["operator"], time.time(), 403), (["admin"], time.time() - 3600, 401)):
            with self.subTest(roles=roles), patch("auth.verify_keycloak_token", return_value={
                "sub": "caller", "realm_access": {"roles": roles}, "auth_time": auth_time,
            }), patch("routers.keycloak_admin._request", new=AsyncMock()) as identity:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                    response = await client.patch("/v1/keycloak/users/operator", headers={"Authorization": "Bearer test"}, json={"checkpointId": "server-room"})
                self.assertEqual(response.status_code, expected, response.text)
                identity.assert_not_awaited()
                db.execute.assert_not_awaited()
                db.commit.assert_not_awaited()

    async def test_omitting_assignment_preserves_it_and_explicit_null_revokes_with_audit(self):
        user = {"id": "operator", "username": "operator", "enabled": True}
        async def identity(token, method, path, payload=None):
            return httpx.Response(200, json=[] if path.endswith("role-mappings/realm") else user)
        assignment = TerminalCheckpointAssignment(terminal_identity="browser:operator", checkpoint_id="server-room")
        db = Mock(get=AsyncMock(return_value=assignment), commit=AsyncMock(), delete=AsyncMock(), add=Mock())
        with patch("routers.keycloak_admin._request", side_effect=identity), patch("routers.keycloak_admin.publish_checkpoint_assignment", new=AsyncMock()) as publish:
            saved = await keycloak_admin.update_user("operator", keycloak_admin.UserUpdateRequest(firstName="Pat"), "token", db, {"sub": "admin"})
            self.assertEqual(saved["checkpointId"], "server-room")
            db.commit.assert_not_awaited()
            db.delete.assert_not_awaited()
            publish.assert_not_awaited()
            db.get.side_effect = [assignment, None]
            removed = await keycloak_admin.update_user("operator", keycloak_admin.UserUpdateRequest(checkpointId=None), "token", db, {"sub": "admin"})
            self.assertIsNone(removed["checkpointId"])
            db.delete.assert_awaited_once_with(assignment)
            db.commit.assert_awaited_once()
            publish.assert_awaited_once_with("browser:operator")
            event = db.add.call_args.args[0]
            self.assertIsInstance(event, AuditEvent)
            self.assertEqual(event.data["actor"], "admin")
            self.assertEqual(event.data["action"], "terminal_checkpoint_removed")

    async def test_operator_creation_without_assignment_rejects_before_keycloak_write(self):
        payload = keycloak_admin.UserCreateRequest(username="operator", password="temporary-password", roles=["operator"])
        with patch("routers.keycloak_admin._request", new=AsyncMock()) as identity:
            with self.assertRaises(HTTPException) as error:
                await keycloak_admin.create_user(payload, "token", Mock(), {"sub": "admin"})
            self.assertEqual(error.exception.status_code, 422)
            identity.assert_not_awaited()

    async def test_physical_certificate_identity_cannot_select_another_checkpoint(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="cp-main", direction="entry")
        db = Mock(scalar=AsyncMock(), commit=AsyncMock(), rollback=AsyncMock(), info={})
        with patch("main.record_scan", new=AsyncMock()) as scan:
            for assignment in (None, TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")):
                db.scalar.return_value = assignment
                with self.subTest(assignment=assignment), self.assertRaises(HTTPException) as error:
                    await process_scan(payload, uuid.uuid4(), db, "CN=door-a")
                self.assertEqual(error.exception.status_code, 403)
            scan.assert_not_awaited()
            db.commit.assert_not_awaited()

    async def test_physical_terminal_uses_its_registered_checkpoint(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="server-room", direction="entry")
        assignment = TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")
        db = Mock(scalar=AsyncMock(return_value=assignment), commit=AsyncMock(), info={})
        response = {"allowed": False, "reason": "Zone not permitted", "subject_id": "person", "decision": {"event": {"direction": "entry"}}}
        key = uuid.uuid4()
        with patch("main.record_scan", new=AsyncMock(return_value=response)) as scan, patch("main.publish_presence_update", new=AsyncMock()):
            result = await process_scan(payload, key, db, "CN=door-a")
        self.assertFalse(result.allowed)
        scan.assert_awaited_once_with(db, key, payload, "door-a")
        db.commit.assert_awaited_once()
