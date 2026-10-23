"""Account administration and physical terminals cannot bypass checkpoint binding."""
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, HTTPException, Request
from database import get_db
from models import Checkpoint, TerminalCheckpointAssignment
from terminal_assignments import require_checkpoint
from routers import keycloak_admin
from main import process_scan
from schemas import ScanPayload


class TerminalAssignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_registered_dynamic_checkpoint_can_be_used_as_an_assignment(self):
        db = Mock(
            scalar=AsyncMock(return_value=TerminalCheckpointAssignment(
                terminal_identity="browser:operator", checkpoint_id="cp-north-lobby")),
            get=AsyncMock(return_value=Checkpoint(id="cp-north-lobby", data={"name": "North Lobby"})),
        )
        self.assertEqual(await require_checkpoint(db, "browser:operator", "cp-north-lobby"), "cp-north-lobby")

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

    async def test_admin_can_change_operator_enabled_state_and_assigned_checkpoint(self):
        user = {"id": "operator", "username": "operator", "enabled": True}
        async def identity(token, method, path, payload=None):
            return httpx.Response(200, json=[{"name": "operator"}] if path.endswith("role-mappings/realm") else user)
        assignment = TerminalCheckpointAssignment(terminal_identity="browser:operator", checkpoint_id="server-room")
        db = Mock(get=AsyncMock(return_value=assignment), execute=AsyncMock(), commit=AsyncMock(), rollback=AsyncMock(), delete=AsyncMock(), add=Mock())
        actor = {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        with patch("routers.keycloak_admin._request", side_effect=identity), \
                patch("routers.keycloak_admin.set_checkpoint_assignment", new=AsyncMock()) as assign, \
                patch("routers.keycloak_admin.enqueue_checkpoint_assignment", new=AsyncMock()) as publish:
            saved = await keycloak_admin.update_user("operator", keycloak_admin.UserUpdateRequest(enabled=False), "token", db, actor)
            self.assertEqual(saved["checkpointId"], "server-room")
            self.assertTrue(saved["canManage"])
            db.commit.assert_not_awaited()
            assign.assert_not_awaited()
            publish.assert_not_awaited()
            moved = await keycloak_admin.update_user("operator", keycloak_admin.UserUpdateRequest(checkpointId="cp-main"), "token", db, actor)
            self.assertEqual(moved["checkpointId"], "cp-main")
            assign.assert_awaited_once_with(db, "browser:operator", "cp-main", "admin")
            db.commit.assert_awaited_once()
            publish.assert_awaited_once_with(db, "browser:operator")

    async def test_operator_creation_without_assignment_rejects_before_keycloak_write(self):
        payload = keycloak_admin.UserCreateRequest(username="operator", password="temporary-password", roles=["operator"])
        with patch("routers.keycloak_admin._request", new=AsyncMock()) as identity:
            with self.assertRaises(HTTPException) as error:
                await keycloak_admin.create_user(payload, "token", Mock(), {
                    "sub": "admin", "realm_access": {"roles": ["admin"]}})
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
        with patch("main.record_scan", new=AsyncMock(return_value=response)) as scan, patch("main.enqueue_presence", new=AsyncMock()) as queue:
            result = await process_scan(payload, key, db, "CN=door-a")
        self.assertFalse(result.allowed)
        scan.assert_awaited_once_with(db, key, payload, "door-a")
        db.commit.assert_awaited_once()
        self.assertIs(queue.await_args.args[0], db)
        self.assertEqual(queue.await_args.args[1]["subject_id"], "person")

    async def test_physical_http_scan_forwards_verified_scope_without_changing_direct_call_contract(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="server-room", direction="entry")
        assignment = TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")
        db = Mock(scalar=AsyncMock(return_value=assignment), commit=AsyncMock(), info={})
        response = {"allowed": False, "reason": "Zone not permitted", "subject_id": "person", "decision": {"event": {"direction": "entry"}}}
        request = Request({"type": "http", "state": {"limit_identity": "terminal:CN=door-a"}})
        key = uuid.uuid4()
        with patch("main.record_scan", new=AsyncMock(return_value=response)) as scan, patch("main.enqueue_presence", new=AsyncMock()):
            await process_scan(payload, key, db, "CN=door-a", request=request)
        scan.assert_awaited_once_with(db, key, payload, "door-a", request_scope=request.scope)
        db.commit.assert_awaited_once()
