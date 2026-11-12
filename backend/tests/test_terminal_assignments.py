"""Account administration and physical terminals cannot bypass checkpoint binding."""
import sys
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, HTTPException, Request
from database import get_db
from models import Checkpoint, OrganizationZone, TerminalCheckpointAssignment
from terminal_assignments import require_checkpoint
from routers import keycloak_admin
from main import process_scan
from schemas import ScanPayload


class TerminalAssignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_registered_dynamic_checkpoint_can_be_used_as_an_assignment(self):
        db = Mock(
            scalar=AsyncMock(),
            get=AsyncMock(return_value=Checkpoint(id="cp-north-lobby", data={"name": "North Lobby"})),
            execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: "cp-north-lobby")),
        )
        self.assertEqual(await require_checkpoint(db, "browser:operator", "cp-north-lobby"), "cp-north-lobby")

    async def test_operator_and_admin_without_step_up_cannot_change_assignments(self):
        app = FastAPI()
        app.include_router(keycloak_admin.router)
        db = Mock(execute=AsyncMock(), commit=AsyncMock())
        app.dependency_overrides[get_db] = lambda: db
        for roles, auth_time, expected in ((["operator"], time.time(), 403), (["zone-admin"], time.time() - 3600, 401)):
            with self.subTest(roles=roles), patch("auth.verify_keycloak_token", return_value={
                "sub": "caller", "iat": int(time.time()), "exp": int(time.time()) + 300,
                "jti": "terminal-assignment-test-token", "realm_access": {"roles": roles}, "auth_time": auth_time,
            }), patch("token_revocation.assert_token_active", new=AsyncMock()), \
                patch("auth.enforce_behavior_admission", new=AsyncMock()), \
                patch("routers.keycloak_admin._request", new=AsyncMock()) as identity:
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
        async def scalars(query):
            result = MagicMock()
            values = ["a", "b"] if "JOIN organization_zones" in str(query) else []
            result.all.return_value = values
            result.__iter__.return_value = iter(values)
            return result
        db = Mock(get=AsyncMock(side_effect=lambda model, identity, **kwargs:
                assignment if model is TerminalCheckpointAssignment else
                Checkpoint(id=identity, zone_id="b", active=True) if model is Checkpoint else None),
            scalar=AsyncMock(return_value=OrganizationZone(id="b", name="B", active=True)),
            scalars=AsyncMock(side_effect=scalars), execute=AsyncMock(), commit=AsyncMock(),
            rollback=AsyncMock(), delete=AsyncMock(), add=Mock())
        actor = {"sub": "admin", "realm_access": {"roles": ["zone-admin"]}}
        with patch("routers.keycloak_admin._request", side_effect=identity), \
                patch("routers.keycloak_admin.set_checkpoint_assignment", new=AsyncMock()) as assign, \
                patch("routers.keycloak_admin.enqueue_checkpoint_assignment", new=AsyncMock()) as publish, \
                patch("routers.keycloak_admin.revoke_principal_tokens", new=AsyncMock()):
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

    async def test_password_creation_requires_invitation_before_keycloak_write(self):
        with patch("routers.keycloak_admin._request", new=AsyncMock()) as identity:
            with self.assertRaises(HTTPException) as error:
                await keycloak_admin.create_user("token", {
                    "sub": "master", "realm_access": {"roles": ["master-admin"]}})
            self.assertEqual(error.exception.status_code, 410)
            identity.assert_not_awaited()

    async def test_physical_certificate_identity_cannot_select_another_checkpoint(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="cp-main", direction="entry")
        db = Mock(scalar=AsyncMock(), get=AsyncMock(return_value=Checkpoint(id="cp-main", zone_id="a", active=True)),
            execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: None)),
            commit=AsyncMock(), rollback=AsyncMock(), info={})
        current_assignment = {"value": None}
        async def scalar(query):
            if "terminal_checkpoint_assignments" in str(query):
                return current_assignment["value"]
            return OrganizationZone(id="a", name="A", active=True)
        db.scalar.side_effect = scalar
        with patch("main.record_scan", new=AsyncMock()) as scan:
            for assignment in (None, TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")):
                current_assignment["value"] = assignment
                with self.subTest(assignment=assignment), self.assertRaises(HTTPException) as error:
                    await process_scan(payload, uuid.uuid4(), db, "CN=door-a")
                self.assertEqual(error.exception.status_code, 403)
            scan.assert_not_awaited()
            db.commit.assert_not_awaited()

    async def test_physical_terminal_uses_its_registered_checkpoint(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="server-room", direction="entry")
        assignment = TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")
        db = Mock(scalar=AsyncMock(return_value=OrganizationZone(id="b", name="B", active=True)),
            get=AsyncMock(return_value=Checkpoint(id="server-room", zone_id="b", active=True)),
            execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: "server-room")),
            commit=AsyncMock(), info={})
        response = {"allowed": False, "reason": "Zone not permitted", "subject_id": "person", "decision": {"event": {"direction": "entry"}}}
        key = uuid.uuid4()
        with patch("main.record_scan", new=AsyncMock(return_value=response)) as scan, patch("main.enqueue_presence", new=AsyncMock()) as queue:
            result = await process_scan(payload, key, db, "CN=door-a")
        self.assertFalse(result.allowed)
        scan.assert_awaited_once_with(db, key, payload, "door-a", validated_checkpoint_id="server-room")
        db.commit.assert_awaited_once()
        self.assertIs(queue.await_args.args[0], db)
        self.assertEqual(queue.await_args.args[1]["subject_id"], "person")

    async def test_physical_http_scan_forwards_verified_scope_without_changing_direct_call_contract(self):
        payload = ScanPayload(barcode="person", terminal_id="door-a", checkpoint_id="server-room", direction="entry")
        assignment = TerminalCheckpointAssignment(terminal_identity="mtls:door-a", checkpoint_id="server-room")
        db = Mock(scalar=AsyncMock(return_value=OrganizationZone(id="b", name="B", active=True)),
            get=AsyncMock(return_value=Checkpoint(id="server-room", zone_id="b", active=True)),
            execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: "server-room")),
            commit=AsyncMock(), info={})
        response = {"allowed": False, "reason": "Zone not permitted", "subject_id": "person", "decision": {"event": {"direction": "entry"}}}
        request = Request({"type": "http", "state": {"limit_identity": "terminal:CN=door-a"}})
        key = uuid.uuid4()
        with patch("main.record_scan", new=AsyncMock(return_value=response)) as scan, patch("main.enqueue_presence", new=AsyncMock()):
            await process_scan(payload, key, db, "CN=door-a", request=request)
        scan.assert_awaited_once_with(db, key, payload, "door-a", validated_checkpoint_id="server-room", request_scope=request.scope)
        db.commit.assert_awaited_once()
