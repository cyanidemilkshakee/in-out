"""ASGI account workflows against a stateful provider and transactional DB stub.

No real identity accounts or production database are contacted. PostgreSQL
assignment visibility is additionally covered in test_database.py.
"""
import copy
import os
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, HTTPException
from auth import verify_admin_request
from database import get_db
from models import AuditEvent, Checkpoint, TerminalCheckpointAssignment, EventOutbox
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from routers import keycloak_admin


class AssignmentStore:
    def __init__(self, checkpoint="cp-main"):
        self.committed = checkpoint
        self.pending = checkpoint
        self.changes = []
        self.commits = 0
        self.rollbacks = 0
        self.fail_commit = False

    async def execute(self, *args, **kwargs):
        pass  # Per-account advisory lock SQL; real locking is in PostgreSQL tests.

    async def get(self, model, identity, **kwargs):
        if model is Checkpoint:
            if identity not in {"cp-main", "server-room"}:
                return None
            return Checkpoint(id=identity, data={"id": identity})
        return SimpleNamespace(checkpoint_id=self.pending) if self.pending else None

    async def flush(self):
        return None

    async def scalar(self, *args, **kwargs):
        return 1

    async def assign(self, db, identity, checkpoint, actor):
        self.pending = checkpoint
        self.changes.append((identity, checkpoint, actor))

    async def commit(self):
        if self.fail_commit:
            raise RuntimeError("isolated commit failure")
        self.committed = self.pending
        self.commits += 1

    async def rollback(self):
        self.pending = self.committed
        self.rollbacks += 1


class IdentityStore:
    def __init__(self, db):
        self.db = db
        self.user = {"id": "existing", "username": "existing", "firstName": "Old", "lastName": "Name",
            "email": "old@example.invalid", "emailVerified": True, "enabled": True}
        self.roles = {"admin", "unrelated-role"}
        self.calls = []
        self.failures = {}
        self.failure_statuses = {}
        self.created = False
        self.deleted = False
        self.missing_location = False

    def fail(self, method, path, count=1, status=503):
        self.failures[(method, path)] = count
        self.failure_statuses[(method, path)] = status

    async def request(self, token, method, path, payload=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        key = (method, path)
        if self.failures.get(key, 0):
            self.failures[key] -= 1
            raise HTTPException(self.failure_statuses[key], "isolated provider failure")
        if method == "POST" and path == "users":
            self.created = True
            self.user = {"id": "created", **payload}
            self.roles = {"unrelated-role"}
            return httpx.Response(201, headers={} if self.missing_location else {"Location": "https://identity.invalid/users/created"})
        if path.startswith("roles/"):
            name = path.split("/")[1]
            return httpx.Response(200, json={"id": name, "name": name})
        if path.endswith("role-mappings/realm"):
            if method == "POST":
                if self.created and any(role["name"] == "operator" for role in payload):
                    assert self.db.committed == "server-room", "Operator assignment must precede role grant"
                    assert not self.user["enabled"], "Incomplete account must remain disabled"
                self.roles.update(role["name"] for role in payload)
            elif method == "DELETE":
                self.roles.difference_update(role["name"] for role in payload)
            return httpx.Response(200, json=[{"id": role, "name": role} for role in sorted(self.roles)])
        if path.endswith("reset-password"):
            return httpx.Response(204)
        if method == "DELETE":
            self.deleted = True
            return httpx.Response(204)
        if method == "PUT":
            self.user.update(payload)
        return httpx.Response(200, json=copy.deepcopy(self.user))


class KeycloakAdminRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = AssignmentStore()
        self.identity = IdentityStore(self.db)
        self.app = FastAPI()
        self.app.include_router(keycloak_admin.router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[keycloak_admin._admin_context] = lambda: "isolated-token"
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(self.app), base_url="http://test")
        self.provider_patch = patch("routers.keycloak_admin._request", side_effect=self.identity.request)
        self.assignment_patch = patch("routers.keycloak_admin.set_checkpoint_assignment", side_effect=self.db.assign)
        self.publish_patch = patch("routers.keycloak_admin.enqueue_checkpoint_assignment", new=AsyncMock())
        self.provider_patch.start()
        self.assignment_patch.start()
        self.publish = self.publish_patch.start()

    async def asyncTearDown(self):
        await self.client.aclose()
        self.provider_patch.stop()
        self.assignment_patch.stop()
        self.publish_patch.stop()

    async def save(self, **overrides):
        return await self.client.patch("/v1/keycloak/users/existing", json={
            "firstName": "New", "email": "new@example.invalid", "roles": ["operator"],
            "checkpointId": "server-room", **overrides})

    async def create(self, **overrides):
        return await self.client.post("/v1/keycloak/users", json={"username": "created", "password": "Isolated9-password",
            "roles": ["operator"], "checkpointId": "server-room", **overrides})

    async def test_combined_save_commits_profile_roles_assignment_and_preserves_other_roles(self):
        result = await self.save()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["roles"], ["operator"])
        self.assertEqual(result.json()["checkpointId"], "server-room")
        self.assertFalse(result.json()["emailVerified"])
        self.assertEqual(self.identity.roles, {"operator", "unrelated-role"})
        self.assertEqual(self.db.committed, "server-room")
        self.assertEqual(self.db.commits, 1)
        self.publish.assert_awaited_once_with(self.db, "browser:existing")

    async def test_failure_after_role_addition_restores_profile_roles_and_assignment(self):
        old = copy.deepcopy(self.identity.user)
        self.identity.fail("DELETE", "users/existing/role-mappings/realm")
        result = await self.save()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertIn("previous account settings were restored", result.json()["detail"])
        self.assertEqual(self.identity.user, old)
        self.assertEqual(self.identity.roles, {"admin", "unrelated-role"})
        self.assertEqual(self.db.committed, "cp-main")
        self.assertEqual(self.db.pending, "cp-main")
        self.publish.assert_not_awaited()

    async def test_assignment_commit_failure_restores_identity_and_does_not_publish(self):
        self.db.fail_commit = True
        old = copy.deepcopy(self.identity.user)
        result = await self.save()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertEqual(self.identity.user, old)
        self.assertEqual(self.identity.roles, {"admin", "unrelated-role"})
        self.assertEqual(self.db.pending, "cp-main")
        self.publish.assert_awaited_once_with(self.db, "browser:existing")
        self.assertGreaterEqual(self.db.rollbacks, 1)

    async def test_failed_compensation_identifies_account_for_recovery(self):
        self.identity.fail("PUT", "users/existing", count=2)
        result = await self.save()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertIn("Recovery is required for Keycloak account existing", result.json()["detail"])
        self.assertEqual(self.db.pending, "cp-main")

    async def test_definite_profile_rejection_does_not_report_a_false_recovery_failure(self):
        self.identity.fail("PUT", "users/existing", status=403)
        result = await self.save()
        self.assertEqual(result.status_code, 403, result.text)
        self.assertNotIn("Recovery is required", result.json()["detail"])
        self.assertEqual(sum(method == "PUT" for method, _, _ in self.identity.calls), 1)
        self.assertEqual(self.db.pending, "cp-main")

    async def test_unconfirmed_role_write_is_rejected_and_restored(self):
        original = self.identity.request
        async def ignores_addition(token, method, path, payload=None):
            if method == "POST" and path.endswith("role-mappings/realm") and any(role["name"] == "operator" for role in payload):
                return httpx.Response(204)  # Accepted response, but provider did not persist it.
            return await original(token, method, path, payload)
        with patch("routers.keycloak_admin._request", side_effect=ignores_addition):
            result = await self.save()
        self.assertEqual(result.status_code, 502, result.text)
        self.assertIn("did not confirm", result.json()["detail"])
        self.assertEqual(self.identity.roles, {"admin", "unrelated-role"})
        self.assertEqual(self.identity.user["firstName"], "Old")
        self.assertEqual(self.db.pending, "cp-main")

    async def test_operator_without_checkpoint_and_invalid_roles_reject_before_writes(self):
        result = await self.save(checkpointId=None)
        self.assertEqual(result.status_code, 422, result.text)
        self.assertTrue(all(method == "GET" for method, _, _ in self.identity.calls))
        for roles in (None, ["realm-admin"], [True], "operator"):
            self.identity.calls.clear()
            result = await self.save(roles=roles)
            self.assertEqual(result.status_code, 422, result.text)
            self.assertEqual(self.identity.calls, [])

    async def test_omitted_and_unchanged_assignment_have_no_assignment_audit_or_commit(self):
        for body in ({"firstName": "New"}, {"checkpointId": "cp-main", "roles": ["admin"]}):
            result = await self.client.patch("/v1/keycloak/users/existing", json=body)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["checkpointId"], "cp-main")
        self.assertEqual(self.db.changes, [])
        self.assertEqual(self.db.commits, 0)

    async def test_legacy_role_command_obeys_combined_operator_assignment_policy(self):
        self.db.pending = self.db.committed = None
        result = await self.client.put("/v1/keycloak/users/existing/roles", json={"roles": ["operator"]})
        self.assertEqual(result.status_code, 422, result.text)
        self.assertEqual(self.identity.roles, {"admin", "unrelated-role"})

    async def test_creation_is_disabled_until_password_assignment_and_roles_are_ready(self):
        self.db.pending = self.db.committed = None
        result = await self.create()
        self.assertEqual(result.status_code, 201, result.text)
        self.assertTrue(result.json()["enabled"])
        self.assertEqual(result.json()["roles"], ["operator"])
        self.assertFalse(self.identity.calls[0][2]["enabled"])
        self.assertEqual(self.db.committed, "server-room")
        self.publish.assert_awaited_once_with(self.db, "browser:created")

    async def test_failed_password_removes_only_new_account(self):
        self.db.pending = self.db.committed = None
        self.identity.fail("PUT", "users/created/reset-password")
        result = await self.create()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertIn("new account was removed", result.json()["detail"])
        self.assertTrue(self.identity.deleted)
        self.assertEqual([path for method, path, _ in self.identity.calls if method == "DELETE"], ["users/created"])
        self.assertIsNone(self.db.committed)

    async def test_failed_role_grant_removes_committed_assignment_and_new_account(self):
        self.db.pending = self.db.committed = None
        self.identity.fail("POST", "users/created/role-mappings/realm")
        result = await self.create()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertTrue(self.identity.deleted)
        self.assertIsNone(self.db.committed)
        self.assertEqual(self.db.commits, 2)
        self.assertEqual(self.publish.await_args_list,
            [call(self.db, "browser:created"), call(self.db, "browser:created")])

    async def test_failed_creation_cleanup_disables_account_and_reports_recovery_id(self):
        self.db.pending = self.db.committed = None
        self.identity.fail("POST", "users/created/role-mappings/realm")
        self.identity.fail("DELETE", "users/created")
        result = await self.create()
        self.assertEqual(result.status_code, 503, result.text)
        self.assertIn("Recovery is required for Keycloak account created", result.json()["detail"])
        self.assertFalse(self.identity.user["enabled"])
        self.assertIsNone(self.db.committed)

    async def test_missing_created_id_reports_disabled_account_without_deleting_an_unknown_user(self):
        self.identity.missing_location = True
        result = await self.create()
        self.assertEqual(result.status_code, 502, result.text)
        self.assertIn("created disabled", result.json()["detail"])
        self.assertFalse(self.identity.user["enabled"])
        self.assertFalse(self.identity.deleted)

    async def test_failed_initial_create_does_not_delete_a_preexisting_account(self):
        async def conflict(*args, **kwargs):
            raise HTTPException(409, "Username already exists")
        with patch("routers.keycloak_admin._request", side_effect=conflict) as provider:
            result = await self.create()
        self.assertEqual(result.status_code, 409, result.text)
        self.assertEqual(provider.await_count, 1)
        self.assertFalse(self.identity.deleted)

    async def test_admin_can_change_operator_profile_and_checkpoint(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.identity.roles = {"operator"}

        profile_edit = await self.client.patch("/v1/keycloak/users/existing", json={"firstName": "Updated"})
        self.assertEqual(profile_edit.status_code, 200, profile_edit.text)
        self.assertEqual(profile_edit.json()["firstName"], "Updated")
        profile_updates = [payload for method, path, payload in self.identity.calls
            if method == "PUT" and path == "users/existing"]
        self.assertEqual(profile_updates[-1]["firstName"], "Updated")

        self.identity.calls.clear()
        access_edit = await self.client.patch("/v1/keycloak/users/existing", json={
            "enabled": False, "checkpointId": "server-room"})
        self.assertEqual(access_edit.status_code, 200, access_edit.text)
        self.assertTrue(access_edit.json()["canManage"])
        self.assertEqual(access_edit.json()["checkpointId"], "server-room")
        self.assertEqual(self.db.committed, "server-room")
        self.assertEqual(self.identity.user["enabled"], False)
        provider_updates = [payload for method, path, payload in self.identity.calls
            if method == "PUT" and path == "users/existing"]
        self.assertEqual(provider_updates[-1]["enabled"], False)

        self.identity.calls.clear()
        checkpoint_only = await self.client.patch("/v1/keycloak/users/existing", json={"checkpointId": "cp-main"})
        self.assertEqual(checkpoint_only.status_code, 200, checkpoint_only.text)
        self.assertEqual(checkpoint_only.json()["checkpointId"], "cp-main")
        self.assertFalse(any(method == "PUT" and path == "users/existing" for method, path, _ in self.identity.calls))

    async def test_admin_can_create_accounts_and_manage_security(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "admin", "realm_access": {"roles": ["admin"]}}
        create = await self.create()
        self.assertEqual(create.status_code, 201, create.text)

        update = await self.client.patch("/v1/keycloak/users/existing", json={"enabled": False})
        self.assertEqual(update.status_code, 200, update.text)
        self.identity.calls.clear()
        password = await self.client.put("/v1/keycloak/users/existing/password", json={
            "password": "Synthetic9-password", "temporary": True})
        self.assertEqual(password.status_code, 200, password.text)
        sessions = await self.client.post("/v1/keycloak/users/existing/logout")
        self.assertEqual(sessions.status_code, 200, sessions.text)

    async def test_accounts_without_an_application_role_are_not_managed(self):
        self.identity.roles = {"unrelated-role"}
        result = await self.client.patch("/v1/keycloak/users/existing", json={"enabled": False})
        self.assertEqual(result.status_code, 404, result.text)
        self.assertFalse(any(method in {"PUT", "POST", "DELETE"} for method, _, _ in self.identity.calls))


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class KeycloakAdminPostgresRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ["TEST_DATABASE_URL"]
        if not make_url(url).database.endswith("_test"):
            raise RuntimeError("Account tests require a dedicated database ending in _test")
        self.schema = "account_test_" + uuid.uuid4().hex
        self.engine = create_async_engine(url, connect_args={"server_settings": {"search_path": f"{self.schema},public"}})
        async with self.engine.begin() as conn:
            await conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended('inout-test-migrations', 0))"))
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public"))
            await conn.execute(text("ALTER EXTENSION pg_trgm SET SCHEMA public"))
            await conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
            def migrate(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                with Operations.context(MigrationContext.configure(connection)):
                    for revision in reversed(list(scripts.walk_revisions())):
                        revision.module.upgrade()
            await conn.run_sync(migrate)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as db:
            for checkpoint_id in ("cp-main", "server-room"):
                if not await db.get(Checkpoint, checkpoint_id):
                    db.add(Checkpoint(id=checkpoint_id, data={"id": checkpoint_id}))
            await db.flush()
            db.add(TerminalCheckpointAssignment(terminal_identity="browser:existing", checkpoint_id="cp-main"))
            await db.commit()
        self.identity = IdentityStore(None)
        self.app = FastAPI()
        self.app.include_router(keycloak_admin.router)
        async def session():
            async with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = session
        self.app.dependency_overrides[keycloak_admin._admin_context] = lambda: "isolated-token"
        self.app.dependency_overrides[verify_admin_request] = lambda: {
            "sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(self.app), base_url="http://test")
        self.provider = patch("routers.keycloak_admin._request", side_effect=self.identity.request)
        self.provider.start()

    async def asyncTearDown(self):
        await self.client.aclose()
        self.provider.stop()
        async with self.engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.engine.dispose()

    async def test_combined_save_persists_assignment_once_with_audit(self):
        body = {"firstName": "New", "roles": ["operator"], "checkpointId": "server-room"}
        for _ in range(2):
            response = await self.client.patch("/v1/keycloak/users/existing", json=body)
            self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as db:
            assignment = await db.get(TerminalCheckpointAssignment, "browser:existing")
            self.assertEqual(assignment.checkpoint_id, "server-room")
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)
            audit = await db.scalar(select(AuditEvent))
            self.assertEqual(audit.data["actor"], "admin")
            self.assertEqual(audit.data["checkpointId"], "server-room")
        async with self.sessions() as db:
            events = (await db.scalars(select(EventOutbox))).all()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].payload["terminalIdentity"], "browser:existing")

    async def test_provider_failure_rolls_back_real_assignment_and_audit(self):
        old = copy.deepcopy(self.identity.user)
        self.identity.fail("DELETE", "users/existing/role-mappings/realm")
        response = await self.client.patch("/v1/keycloak/users/existing", json={
            "firstName": "New", "roles": ["operator"], "checkpointId": "server-room"})
        self.assertEqual(response.status_code, 503, response.text)
        async with self.sessions() as db:
            assignment = await db.get(TerminalCheckpointAssignment, "browser:existing")
            self.assertEqual(assignment.checkpoint_id, "cp-main")
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 0)
        self.assertEqual(self.identity.user, old)
        self.assertEqual(self.identity.roles, {"admin", "unrelated-role"})
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(EventOutbox)), 0)


if __name__ == "__main__":
    unittest.main()
