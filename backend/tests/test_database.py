"""Run with TEST_DATABASE_URL pointing to a dedicated database ending in _test."""
import os
import sys
import uuid
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch
import importlib.util
import asyncio
import hashlib
import json
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy import text, select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.engine import make_url
from database import get_db, get_read_db
from models import Subject, Person, HardwareAsset, Checkpoint, Movement, PresenceState, PermissionRequestModel, AccessPermission, AuditEvent, Alert, ScanRequest, TerminalCheckpointAssignment
from schemas import BrowserScanPayload, ScanPayload
from terminal_scans import record_scan
from auth import verify_admin_request, verify_terminal_access_request
from routers import movements, terminal, permissions, registry, alerts, admin_profile
from permission_decisions import apply_permission_decision

TEST_URL = os.getenv("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not make_url(TEST_URL).database.endswith("_test"):
            raise RuntimeError("Integration tests require a database ending in _test")
        self.schema = "test_" + uuid.uuid4().hex
        self.engine = create_async_engine(TEST_URL, connect_args={"server_settings": {"search_path": self.schema}})
        async with self.engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
            def migrate(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                with Operations.context(MigrationContext.configure(connection)):
                    for revision in reversed(list(scripts.walk_revisions())):
                        revision.module.upgrade()
            await conn.run_sync(migrate)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as db:
            checkpoint = await db.get(Checkpoint, "cp-main")
            checkpoint_data = {"id": "cp-main", "name": "Main Entrance", "mode": "auto", "zone": "public"}
            if checkpoint:
                checkpoint.data = checkpoint_data
            else:
                db.add(Checkpoint(id="cp-main", data=checkpoint_data))
            db.add(Subject(id="p1", kind="employee", barcode="p1", person=Person(data={
                "name": "Alice", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            db.add(Subject(id="h1", kind="hardware", barcode="h1", hardware=HardwareAsset(data={
                "name": "Laptop", "category": "Laptop", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            await db.flush()
            db.add_all([TerminalCheckpointAssignment(terminal_identity="browser:" + name, checkpoint_id="cp-main")
                for name in ("operator", "test-operator")])
            await db.commit()
        self.app = FastAPI()
        self.app.include_router(movements.router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(terminal.router, dependencies=[Depends(verify_terminal_access_request)])
        self.app.include_router(permissions.router)
        self.app.include_router(registry.router)
        self.app.include_router(registry.bundle_router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(alerts.router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(admin_profile.router)
        async def session():
            async with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = session
        self.app.dependency_overrides[get_read_db] = session
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        async with self.engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.engine.dispose()

    async def test_unauthenticated_reads_and_writes_are_rejected(self):
        self.assertEqual((await self.client.get("/v1/movements")).status_code, 401)
        self.assertEqual((await self.client.post("/v1/terminal/scans", json={})).status_code, 401)
        self.assertEqual((await self.client.post("/v1/permissions/grant", json={})).status_code, 401)

    def _direct_grant(self, **fields):
        now = datetime.now(timezone.utc)
        return {"subject_id": "p1", "checkpoint_id": "cp-main", "request_type": "zone_access",
            "reason": "Verified by administrator", "requested_zones": ["public", "secure"],
            "valid_from": now.isoformat(), "valid_to": (now + timedelta(hours=2)).isoformat(), **fields}

    async def test_direct_visitor_grant_is_atomic_active_and_archived_without_workflow(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        payload = self._direct_grant(subject_id="", request_type="visitor", barcode="direct-visitor",
            new_visitor={"name": "Direct visitor", "host": "Alice", "company": "Example"})
        with patch("routers.permissions.publish_decision", new=AsyncMock()) as publish, \
             patch("routers.permissions.get_temporal_client", new=AsyncMock()) as temporal:
            response = await self.client.post("/v1/permissions/grant", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        result = response.json()
        self.assertEqual(result["request"]["status"], "approved")
        self.assertEqual(result["permission"]["source"], "manual")
        self.assertEqual(result["person"]["status"], "pre_approved")
        self.assertEqual(result["permission"]["zones"], ["public", "secure"])
        self.assertEqual(result["request"]["decidedBy"], "grant-admin")
        temporal.assert_not_awaited()
        publish.assert_awaited_once()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(PermissionRequestModel)
                .where(PermissionRequestModel.data["status"].astext == "pending")), 0)
            self.assertEqual((await db.get(Person, result["request"]["subjectId"])).data["host"], "Alice")
        history = (await self.client.get("/v1/registry/bundle")).json()
        self.assertIn(result["request"]["id"], [item["id"] for item in history["permissionRequests"]])
        directory = (await self.client.get("/v1/permissions")).json()
        self.assertIn(result["request"]["subjectId"], [item["subjectId"] for item in directory["people"]])

    async def test_direct_existing_visitor_grant_decides_pending_permission_once(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Subject(id="pending-visitor", barcode="pending-visitor", kind="visitor",
                person=Person(data={"name": "Guest", "status": "pending_approval", "allowedZones": [], "inside": False})))
            await db.flush()
            db.add(PermissionRequestModel(id="pending-visitor-request", subject_id="pending-visitor", created_at=now,
                data={"id": "pending-visitor-request", "type": "visitor", "status": "pending", "requester": "operator",
                    "subjectId": "pending-visitor", "subjectName": "Guest", "createdAt": now.isoformat(),
                    "requestedZones": ["public"], "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=1)).isoformat()}))
            await db.commit()
        with patch("routers.permissions.publish_decision", new=AsyncMock()), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            response = await self.client.post("/v1/permissions/grant", json=self._direct_grant(
                subject_id="pending-visitor", request_type="visitor"))
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["request"]["id"], "pending-visitor-request")
        async with self.sessions() as db:
            requests = (await db.scalars(select(PermissionRequestModel).where(
                PermissionRequestModel.subject_id == "pending-visitor"))).all()
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].data["status"], "approved")
            self.assertEqual((await db.get(Person, "pending-visitor")).data["allowedZones"], ["public", "secure"])

    async def _pending_visitor_grant_fixture(self, db, include_request=True):
        now = datetime.now(timezone.utc)
        db.add(Subject(id="grant-race-visitor", barcode="grant-race-visitor", kind="visitor",
            person=Person(data={"name": "Race guest", "status": "pending_approval", "inside": False, "allowedZones": []})))
        await db.flush()
        if not include_request:
            return
        db.add(PermissionRequestModel(id="grant-race-request", subject_id="grant-race-visitor", created_at=now,
            data={"id": "grant-race-request", "subjectId": "grant-race-visitor", "subjectName": "Race guest",
                "type": "visitor", "status": "pending", "createdAt": now.isoformat(), "requester": "operator",
                "requestedZones": ["public"], "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=1)).isoformat()}))
        await db.flush()

    async def test_direct_zone_grant_resolves_visitor_workflow_instead_of_leaving_timeout_revocation(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        async with self.sessions() as db:
            await self._pending_visitor_grant_fixture(db)
            await db.commit()
        with patch("routers.permissions.publish_decision", new=AsyncMock()), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            response = await self.client.post("/v1/permissions/grant", json=self._direct_grant(subject_id="grant-race-visitor"))
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["request"]["id"], "grant-race-request")
        self.assertEqual(response.json()["request"]["type"], "visitor")
        async with self.sessions() as db:
            timeout = await apply_permission_decision(db, "grant-race-request", "denied", "system", "Timeout", from_activity=True)
            await db.commit()
            self.assertEqual(timeout["request"]["status"], "approved")
            self.assertEqual((await db.get(Person, "grant-race-visitor")).data["status"], "pre_approved")
        directory = (await self.client.get("/v1/permissions")).json()
        self.assertEqual(next(item for item in directory["people"] if item["subjectId"] == "grant-race-visitor")["source"], "manual")

    async def test_direct_grant_waits_for_creator_and_reuses_newly_committed_pending_visitor(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        async with self.sessions() as creator:
            await self._pending_visitor_grant_fixture(creator, include_request=False)
            await creator.commit()
            await creator.scalar(select(Subject).where(Subject.id == "grant-race-visitor").with_for_update())
            now = datetime.now(timezone.utc)
            creator.add(PermissionRequestModel(id="grant-race-request", subject_id="grant-race-visitor", created_at=now,
                data={"id": "grant-race-request", "type": "visitor", "status": "pending", "subjectId": "grant-race-visitor",
                    "subjectName": "Race guest", "createdAt": now.isoformat(), "requester": "operator",
                    "requestedZones": ["public"], "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=1)).isoformat()}))
            await creator.flush()
            with patch("routers.permissions.publish_decision", new=AsyncMock()), \
                 patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
                grant = asyncio.create_task(self.client.post("/v1/permissions/grant", json=self._direct_grant(subject_id="grant-race-visitor")))
                await asyncio.sleep(0.05)
                self.assertFalse(grant.done(), "Grant must wait for the subject creation/update transaction")
                await creator.commit()
                response = await asyncio.wait_for(grant, 5)
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["request"]["id"], "grant-race-request")
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(PermissionRequestModel)), 1)

    async def test_direct_grant_returns_conflict_for_locked_pending_decision_without_partial_grant(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        async with self.sessions() as db:
            await self._pending_visitor_grant_fixture(db)
            await db.commit()
            await db.scalar(select(PermissionRequestModel).where(PermissionRequestModel.id == "grant-race-request").with_for_update())
            response = await asyncio.wait_for(self.client.post("/v1/permissions/grant",
                json=self._direct_grant(subject_id="grant-race-visitor")), 5)
            self.assertEqual(response.status_code, 409, response.text)
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(PermissionRequestModel, "grant-race-request")).data["status"], "pending")
            self.assertEqual(await db.scalar(select(func.count()).select_from(AccessPermission)), 0)

    async def test_direct_custody_grant_changes_carrier_without_expiring_or_changing_zones(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        with patch("routers.permissions.publish_decision", new=AsyncMock()):
            response = await self.client.post("/v1/permissions/grant", json=self._direct_grant(
                subject_id="h1", request_type="hardware_custody", carrier_id="p1", carrier_name="Forged", hardware_id="h1"))
        self.assertEqual(response.status_code, 201, response.text)
        result = response.json()
        self.assertEqual(result["hardwareAsset"]["assignedEmployeeName"], "Alice")
        self.assertEqual(result["request"]["validTo"], "")
        self.assertIsNone(result["permission"])
        async with self.sessions() as db:
            self.assertEqual((await db.get(HardwareAsset, "h1")).data["allowedZones"], ["All Zones"])
        retry = await self.client.post("/v1/permissions/grant", json=self._direct_grant(
            subject_id="h1", request_type="hardware_custody", carrier_id="p1"))
        self.assertEqual(retry.status_code, 422, retry.text)

    async def test_invalid_direct_grants_and_effect_failure_leave_no_partial_identity_or_history(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "grant-admin"}
        for changes in ({"valid_to": "2126-10-06T10:00:00Z"}, {"requested_zones": []},
                        {"request_type": "manual_override"}, {"subject_id": "h1", "request_type": "hardware_custody", "carrier_id": "h1"}):
            response = await self.client.post("/v1/permissions/grant", json=self._direct_grant(**changes))
            self.assertEqual(response.status_code, 422, response.text)
        duplicate = await self.client.post("/v1/permissions/grant", json=self._direct_grant(subject_id="", request_type="visitor",
            barcode="P1", new_visitor={"name": "Duplicate", "host": "Alice"}))
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        with patch("permission_grants.apply_permission_decision", new=AsyncMock(side_effect=RuntimeError("effect failed"))):
            with self.assertRaisesRegex(RuntimeError, "effect failed"):
                await self.client.post("/v1/permissions/grant", json=self._direct_grant(subject_id="", request_type="visitor",
                    barcode="rollback-visitor", new_visitor={"name": "Rollback", "host": "Alice"}))
        async with self.sessions() as db:
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "rollback-visitor")))
            self.assertEqual(await db.scalar(select(func.count()).select_from(PermissionRequestModel)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 0)

    async def test_account_checkpoint_rejects_spoofing_before_scan_or_review(self):
        from auth import verify_admin_or_operator_request
        actor = {"sub": "operator", "realm_access": {"roles": ["operator"]}, "checkpointId": "cp-main"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: actor
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: actor
        async with self.sessions() as db:
            assignment = await db.get(TerminalCheckpointAssignment, "browser:operator")
            assignment.checkpoint_id = "server-room"
            person = await db.get(Person, "p1")
            person.data = {**person.data, "allowedZones": ["public"]}
            await db.commit()
        headers = {"Idempotency-Key": str(uuid.uuid4())}
        forged = await self.client.post("/v1/terminal/scans", json={"barcode": "p1", "checkpointId": "cp-main"}, headers=headers)
        self.assertEqual(forged.status_code, 403, forged.text)
        review = await self.client.post("/v1/terminal/manual-reviews", json={"barcode": "p1", "checkpointId": "cp-main", "operatorNote": "Checked ID"})
        self.assertEqual(review.status_code, 403, review.text)
        generic_review = await self.client.post("/v1/permission-requests", json={"subject_id": "p1", "checkpoint_id": "cp-main",
            "request_type": "manual_override", "reason": "Checked ID", "operator_note": "Checked ID"})
        self.assertEqual(generic_review.status_code, 403, generic_review.text)
        async with self.sessions() as db:
            for model in (Movement, ScanRequest, PermissionRequestModel, PresenceState):
                self.assertEqual(await db.scalar(select(func.count()).select_from(model)), 0)
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            honest = await self.client.post("/v1/terminal/scans", json={"barcode": "p1", "checkpointId": "server-room"}, headers=headers)
        self.assertEqual(honest.status_code, 200, honest.text)
        self.assertFalse(honest.json()["allowed"])
        self.assertEqual(honest.json()["decision"]["event"]["denialCode"], "zone_not_permitted")
        bundle = (await self.client.get("/v1/terminal/bundle")).json()
        self.assertEqual([cp["id"] for cp in bundle["checkpoints"]], ["server-room"])
        self.assertEqual(bundle["terminalAssignment"], {"operatorSubject": "operator", "checkpointId": "server-room"})

    async def test_unassigned_accounts_and_revoked_retries_fail_closed(self):
        from terminal_assignments import set_checkpoint_assignment
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "unassigned"}
        body = {"barcode": "p1", "checkpointId": "cp-main"}
        headers = {"Idempotency-Key": str(uuid.uuid4())}
        self.assertEqual((await self.client.post("/v1/terminal/scans", json=body, headers=headers)).status_code, 403)
        bundle = (await self.client.get("/v1/terminal/bundle")).json()
        self.assertEqual(bundle["checkpoints"], [])
        self.assertIsNone(bundle["terminalAssignment"]["checkpointId"])
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()) as publish:
            original = await self.client.post("/v1/terminal/scans", json=body, headers=headers)
            self.assertEqual(original.status_code, 200, original.text)
            self.assertEqual((await self.client.post("/v1/terminal/scans", json=body, headers=headers)).json(), original.json())
            async with self.sessions() as db:
                await set_checkpoint_assignment(db, "browser:operator", "server-room", "admin")
                await db.commit()
            self.assertEqual((await self.client.post("/v1/terminal/scans", json=body, headers=headers)).status_code, 403)
            # Rewriting the old queued request must not create a second scan.
            changed = await self.client.post("/v1/terminal/scans", json={**body, "checkpointId": "server-room"}, headers=headers)
            self.assertEqual(changed.status_code, 409, changed.text)
            async with self.sessions() as db:
                await set_checkpoint_assignment(db, "browser:operator", None, "admin")
                await db.commit()
            self.assertEqual((await self.client.post("/v1/terminal/scans", json=body, headers=headers)).status_code, 403)
            publish.assert_awaited_once()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 2)

    async def test_dashboard_reads_committed_changes_without_redis(self):
        from routers.dashboard import get_dashboard
        with patch("redis_client.get_redis_pool", side_effect=AssertionError("Dashboard must not use Redis")):
            async with self.sessions() as db:
                before = await get_dashboard(db)
            async with self.sessions() as db:
                result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
                await db.commit()
            async with self.sessions() as db:
                after = await get_dashboard(db)
            self.assertEqual(after["analytics"]["totalScans"], before["analytics"]["totalScans"] + 1)
            self.assertEqual(after["analytics"]["activeInside"], 1)
            self.assertEqual(after["recentMovements"][0]["id"], result["decision"]["event"]["id"])

    async def test_admin_creates_operator_with_checkpoint_before_granting_role(self):
        import time
        from routers import keycloak_admin
        self.app.include_router(keycloak_admin.router)
        user_id = "new-operator-id"
        user = {"id": user_id, "username": "new-operator", "enabled": True}
        granted_roles = []

        async def identity(token, method, path, payload=None):
            if method == "POST" and path == "users":
                return httpx.Response(201, headers={"Location": "https://identity.invalid/users/" + user_id})
            if path.endswith("role-mappings/realm"):
                if method == "POST":
                    # A separately committed assignment must exist before the
                    # new account receives permission to use the terminal.
                    async with self.sessions() as db:
                        assignment = await db.get(TerminalCheckpointAssignment, "browser:" + user_id)
                        self.assertEqual(assignment.checkpoint_id, "server-room")
                    granted_roles.extend(payload)
                    return httpx.Response(204)
                return httpx.Response(200, json=granted_roles)
            if path == "roles/operator":
                return httpx.Response(200, json={"id": "operator-role", "name": "operator"})
            if path.endswith("reset-password"):
                return httpx.Response(204)
            return httpx.Response(200, json=user)

        headers = {"Authorization": "Bearer isolated-test-token"}
        actor = {"sub": "setup-admin", "realm_access": {"roles": ["admin"]}, "auth_time": time.time()}
        with patch("auth.verify_keycloak_token", return_value=actor) as token, \
             patch("routers.keycloak_admin._request", side_effect=identity), \
             patch("routers.keycloak_admin.publish_checkpoint_assignment", new=AsyncMock()) as publish:
            response = await self.client.post("/v1/keycloak/users", headers=headers, json={
                "username": "new-operator", "password": "isolated-test-password", "roles": ["operator"], "checkpointId": "server-room",
            })
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(response.json()["checkpointId"], "server-room")
            self.assertEqual(response.json()["roles"], ["operator"])
            publish.assert_awaited_once_with("browser:" + user_id)
            async with self.sessions() as db:
                audit = await db.scalar(select(AuditEvent))
                self.assertEqual(audit.data["actor"], "setup-admin")
            token.return_value = {"sub": user_id, "realm_access": {"roles": ["operator"]}}
            bundle = await self.client.get("/v1/terminal/bundle", headers=headers)
            self.assertEqual(bundle.status_code, 200, bundle.text)
            self.assertEqual([cp["id"] for cp in bundle.json()["checkpoints"]], ["server-room"])
            # Newly created operators cannot choose Main Entrance or manage accounts.
            forged = await self.client.post("/v1/terminal/scans", headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
                json={"barcode": "p1", "checkpointId": "cp-main"})
            self.assertEqual(forged.status_code, 403)
            self.assertEqual((await self.client.get("/v1/keycloak/users", headers=headers)).status_code, 403)

    async def test_offline_timestamp_and_hardware_payloads_are_retryable(self):
        async with self.sessions() as db:
            body = BrowserScanPayload(barcode="p1", checkpointId="cp-main", capturedOfflineAt="2026-09-28T10:00:00Z")
            key = uuid.uuid4()
            first = await record_scan(db, key, body, "operator")
            await db.commit()
            self.assertEqual(first, await record_scan(db, key, body, "operator"))
            self.assertTrue(db.info["scan_replayed"])
            hardware = ScanPayload(barcode="h1", terminal_id="physical", checkpoint_id="cp-main", direction="entry")
            result = await record_scan(db, uuid.uuid4(), hardware, "physical")
            self.assertTrue(result["allowed"])
            self.assertFalse(db.info["scan_replayed"])
            await db.commit()

    async def test_retry_does_not_publish_an_old_presence_event(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}
        headers = {"Idempotency-Key": str(uuid.uuid4())}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()) as publish:
            for _ in range(2):
                response = await self.client.post("/v1/terminal/scans", json={"barcode": "p1", "checkpointId": "cp-main"}, headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
            publish.assert_awaited_once()

    async def test_approval_window_is_persisted_and_dashboard_excludes_equipment(self):
        from routers.dashboard import get_dashboard
        async with self.sessions() as db:
            now = datetime.now(timezone.utc)
            db.add(PermissionRequestModel(id="window", subject_id="p1", created_at=now, data={
                "id": "window", "subjectId": "p1", "subjectName": "Alice", "status": "pending", "type": "zone_access",
                "requestedZones": ["public"], "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=8)).isoformat()}))
            await db.commit()
            result = await apply_permission_decision(db, "window", "approved", "admin", "Checked", valid_for_minutes=45)
            await db.commit()
            saved = (await db.get(PermissionRequestModel, "window")).data
            self.assertEqual(saved["validTo"], result["permission"]["validTo"])
            # Non-manual approvals preserve the requested window even if an
            # older client submits a generic Valid for duration.
            self.assertEqual(datetime.fromisoformat(saved["validTo"]) - datetime.fromisoformat(saved["validFrom"]), timedelta(hours=8))
            db.add_all([PresenceState(subject_id="p1", state="inside"), PresenceState(subject_id="h1", state="inside")])
            await db.commit()
            dashboard = await get_dashboard(db)
            self.assertEqual(dashboard["analytics"]["activeInside"], 1)

    async def test_subject_deletion_preserves_history_and_deletes_unused_subject(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "operator")
            await db.commit()
        retained = await self.client.delete("/v1/registry/subjects/p1")
        self.assertEqual(retained.status_code, 409, retained.text)
        removed = await self.client.delete("/v1/registry/subjects/h1")
        self.assertEqual(removed.status_code, 204, removed.text)

    async def test_retention_keeps_manual_review_evidence(self):
        from maintenance import cleanup
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="unknown", checkpointId="cp-main"), "operator")
            await db.commit()
            event = result["decision"]["event"]
            await self._create_review(db, barcode="unknown", event=event)
            movement = await db.get(Movement, event["id"])
            movement.occurred_at = datetime.now(timezone.utc) - timedelta(days=10)
            await db.commit()
        with patch("maintenance.async_session", self.sessions), patch("maintenance.settings.MOVEMENT_RETENTION_DAYS", 1):
            result = await cleanup(apply=True)
        self.assertEqual(result["movements"], 0)

    async def test_browser_scan_retry_hardware_and_movement_filters(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "p1", "checkpointId": "cp-main", "selectedHardwareIds": ["h1"], "scanType": "auto", "online": True}
        headers = {"Idempotency-Key": str(uuid.uuid4())}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            response = await self.client.post("/v1/terminal/scans", json=body, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertEqual(result["decision"]["event"]["subjectName"], "Alice")
            self.assertTrue(result["updatedPeople"][0]["inside"])
            self.assertTrue(result["updatedHardwareAssets"][0]["inside"])
            retry = await self.client.post("/v1/terminal/scans", json=body, headers=headers)
            self.assertEqual(retry.json(), result)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            # Cooldown has elapsed; auto mode must derive an exit from persisted presence.
            state = await db.get(PresenceState, "p1")
            state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            await db.commit()
            exit_result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(**body), "browser:test-admin")
            self.assertEqual(exit_result["decision"]["event"]["direction"], "exit")
            self.assertTrue(exit_result["allowed"])
            await db.commit()
        page = await self.client.get("/v1/movements", params={"search": "Alice", "checkpoint": "Main Entrance", "scanType": "auto", "subjectGroup": "people", "pageSize": 1, "page": 2})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["total"], 2)
        self.assertEqual(len(page.json()["items"]), 1)
        self.assertNotIn("chartItems", page.json())
        analytics = await self.client.get("/v1/movements/analytics", params={"search": "Alice"})
        self.assertEqual(analytics.status_code, 200, analytics.text)
        self.assertEqual(analytics.json()["summary"]["total"], 2)
        self.assertEqual(len(analytics.json()["items"]), 2)
        bundle = await self.client.get("/v1/terminal/bundle")
        self.assertEqual(bundle.status_code, 200, bundle.text)
        self.assertNotIn("subjects", bundle.json())
        self.assertEqual([asset["id"] for asset in bundle.json()["hardwareAssets"]], ["h1"])
        for params in ({"search": "Missing"}, {"scanType": "manual"}, {"subjectGroup": "hardware"}, {"startAt": "2099-01-01T00:00:00Z"}, {"endAt": "2000-01-01T00:00:00Z"}):
            self.assertEqual((await self.client.get("/v1/movements", params=params)).json()["total"], 0)

    async def test_movement_references_search_and_resolve_across_default_filters(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        event_ids = [str(uuid.uuid4()), "MAN-" + uuid.uuid4().hex, "EVT-000123"]
        async with self.sessions() as db:
            for event_id in event_ids:
                db.add(Movement(id=event_id, subject_id="h1", checkpoint_id="cp-main",
                    occurred_at=datetime(2020, 1, 1, tzinfo=timezone.utc), result="approved",
                    direction="entry", scan_type="manual", subject_type="hardware", sync_state="synced",
                    data={"id": "stale-display-id", "subjectName": "Laptop", "barcode": "h1"}))
            await db.commit()
        for event_id in event_ids:
            # Text search must find both complete IDs and fragments.
            for search in [event_id.lower(), event_id[-10:]]:
                page = await self.client.get("/v1/movements", params={"search": search})
                self.assertEqual(page.status_code, 200, page.text)
                self.assertEqual([item["id"] for item in page.json()["items"]], [event_id])
            # A direct reference overrides stale filters, and chart/table use
            # the same identity even if historical display metadata differs.
            params = {"eventId": event_id.lower(), "subjectGroup": "people",
                "startAt": "2099-01-01T00:00:00Z", "checkpoint": "elsewhere", "result": "denied"}
            for endpoint in ["/v1/movements", "/v1/movements/analytics"]:
                response = await self.client.get(endpoint, params=params)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([item["id"] for item in response.json()["items"]], [event_id])
            notes_url = f"/v1/movements/{event_id}/notes"
            note = await self.client.post(notes_url, json={"note": "Verified event reference"})
            self.assertEqual(note.status_code, 200, note.text)
            page = (await self.client.get("/v1/movements", params=params)).json()
            self.assertEqual(page["movementNotes"][event_id], ["Verified event reference"])
        missing = await self.client.get("/v1/movements", params={"eventId": "missing"})
        self.assertEqual(missing.json()["total"], 0)

    async def test_direct_hardware_scan_and_custody_denial(self):
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "someone-else"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"]), "test")
            self.assertFalse(denied["allowed"])
            self.assertEqual(denied["decision"]["event"]["denialCode"], "custody_mismatch")
            await db.commit()
            approved = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp-main"), "test")
            self.assertTrue(approved["allowed"])
            self.assertEqual(approved["decision"]["event"]["subjectType"], "hardware")
            await db.commit()

    async def _create_review(self, db, barcode="unknown-1", subject_id=None, event=None, kind="manual_override"):
        now = datetime.now(timezone.utc)
        req_id = "REQ-" + uuid.uuid4().hex
        req = PermissionRequestModel(id=req_id, subject_id=subject_id, created_at=now, data={
            "id": req_id, "barcode": barcode, "subjectId": subject_id or "", "subjectName": "Reviewed visitor",
            "subjectType": "visitor", "type": kind, "status": "pending", "checkpointId": "cp-main",
            "direction": "entry", "requestedZones": ["public"], "validFrom": now.isoformat(),
            "validTo": (now + timedelta(hours=1)).isoformat(),
            **({"eventId": event["id"]} if event else {}),
        })
        db.add(req)
        await db.commit()
        return req_id

    async def _submit_unknown_manual_review(self, barcode):
        body = {"barcode": barcode, "checkpointId": "cp-main"}
        denied = await self.client.post("/v1/terminal/scans", json=body,
            headers={"Idempotency-Key": str(uuid.uuid4())})
        self.assertEqual(denied.status_code, 200, denied.text)
        self.assertFalse(denied.json()["allowed"])
        review = await self.client.post("/v1/terminal/manual-reviews", json={
            **body, "direction": "entry", "eventId": denied.json()["decision"]["event"]["id"],
            "operatorNote": "Verified photo ID at the gate.",
        })
        self.assertEqual(review.status_code, 200, review.text)
        return body, review.json()

    async def test_manual_approval_durations_gate_one_rescan_and_retries_do_not_extend_the_window(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            for selected in (None, 15, 30, 60, 120, 240):
                with self.subTest(selected=selected):
                    body, review = await self._submit_unknown_manual_review("duration-" + str(selected))
                    async with self.sessions() as db:
                        request = await db.get(PermissionRequestModel, review["id"])
                        # A pending review's old proposed dates never determine
                        # the admin-selected one-visit approval window.
                        request.data = {**request.data, "validFrom": "2000-01-01T00:00:00Z", "validTo": "2000-01-01T01:00:00Z"}
                        audits_before = await db.scalar(select(func.count()).select_from(AuditEvent))
                        await db.commit()
                    before = datetime.now(timezone.utc)
                    url = f"/v1/permission-requests/{review['id']}/decide"
                    approval = {"decision": "approved", "reason": "Checked ID",
                        **({"valid_for_minutes": selected} if selected is not None else {})}
                    response = await self.client.post(url, json=approval)
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    approved = result["request"]
                    start = datetime.fromisoformat(approved["validFrom"])
                    end = datetime.fromisoformat(approved["validTo"])
                    self.assertGreaterEqual(start, before)
                    self.assertLessEqual(start, datetime.now(timezone.utc))
                    self.assertEqual(start.isoformat(), approved["decidedAt"])
                    self.assertEqual(end - start, timedelta(minutes=selected if selected is not None else 60))
                    subject_id = approved["subjectId"]
                    async with self.sessions() as db:
                        request = await db.get(PermissionRequestModel, review["id"])
                        self.assertEqual(request.data, approved)
                        state = await db.get(PresenceState, subject_id)
                        self.assertIsNone(state)
                        self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                        self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), audits_before + 1)
                    # Approval prepares one time-limited rescan; it does not
                    # retroactively admit the person or change the denied scan.
                    retry = await self.client.post(url, json={**approval, "valid_for_minutes": 15 if selected == 240 else 240})
                    self.assertEqual(retry.status_code, 200, retry.text)
                    self.assertEqual(retry.json()["request"], approved)
                    async with self.sessions() as db:
                        state = await db.get(PresenceState, subject_id)
                        self.assertIsNone(state)
                        self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), audits_before + 1)
                        self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)
                            .where(Movement.data["manualApprovalRequestId"].astext == review["id"])), 0)
                    entered = await self.client.post("/v1/terminal/scans", json=body,
                        headers={"Idempotency-Key": str(uuid.uuid4())})
                    self.assertTrue(entered.json()["allowed"], entered.text)
                    self.assertEqual(entered.json()["decision"]["event"]["scanType"], "manual")
                    self.assertEqual(entered.json()["decision"]["event"]["manualApprovalRequestId"], review["id"])
                    self.assertTrue(entered.json()["manualApprovalRequest"]["consumedAt"])
                    async with self.sessions() as db:
                        state = await db.get(PresenceState, subject_id)
                        self.assertEqual(state.state, "inside")
                        self.assertEqual(state.entry_override["validTo"], approved["validTo"])
                        self.assertEqual(state.entry_override["requestId"], review["id"])
                        self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)
                            .where(Movement.data["manualApprovalRequestId"].astext == review["id"])), 1)
                    exited = await self.client.post("/v1/terminal/scans", json=body,
                        headers={"Idempotency-Key": str(uuid.uuid4())})
                    self.assertTrue(exited.json()["allowed"], exited.text)
                    self.assertEqual(exited.json()["decision"]["event"]["direction"], "exit")
                    # A matching exit consumes the visit even while its selected
                    # window is still open. Skip cooldown using a server clock,
                    # not by extending or changing the saved access grant.
                    next_scan = start + timedelta(seconds=20)
                    self.assertLess(next_scan, end)
                    async with self.sessions() as db:
                        state = await db.get(PresenceState, subject_id)
                        state.last_scan_timestamp = next_scan - timedelta(seconds=11)
                        await db.commit()
                    with patch("movement_logic.datetime", wraps=datetime) as policy_clock, \
                         patch("terminal_scans.datetime", wraps=datetime) as scan_clock:
                        policy_clock.now.return_value = next_scan
                        scan_clock.now.return_value = next_scan
                        reentry = await self.client.post("/v1/terminal/scans", json=body,
                            headers={"Idempotency-Key": str(uuid.uuid4())})
                    self.assertEqual(reentry.status_code, 200, reentry.text)
                    self.assertFalse(reentry.json()["allowed"])
                    self.assertNotEqual(reentry.json()["reason"], "Cooldown active")
                    async with self.sessions() as db:
                        state = await db.get(PresenceState, subject_id)
                        self.assertEqual(state.state, "outside")
                        self.assertIsNone(state.entry_override)

    async def test_invalid_manual_durations_leave_pending_and_applied_requests_unchanged(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        invalid = (0, -1, 241, 1000000, 20, 45, True, False, 15.0, 15.5, "15")
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            _, review = await self._submit_unknown_manual_review("invalid-duration")
            url = f"/v1/permission-requests/{review['id']}/decide"
            for status in ("pending", "approved"):
                async with self.sessions() as db:
                    saved = dict((await db.get(PermissionRequestModel, review["id"])).data)
                    movement_count = await db.scalar(select(func.count()).select_from(Movement))
                    audit_count = await db.scalar(select(func.count()).select_from(AuditEvent))
                    state = await db.get(PresenceState, saved["subjectId"]) if saved.get("subjectId") else None
                    presence = (state.state, state.last_scan_timestamp, dict(state.entry_override)) if state else None
                for duration in invalid:
                    with self.subTest(status=status, duration=repr(duration)):
                        response = await self.client.post(url, json={
                            "decision": "approved", "reason": "Checked ID", "valid_for_minutes": duration,
                        })
                        self.assertEqual(response.status_code, 422, response.text)
                        async with self.sessions() as db:
                            with self.assertRaises(HTTPException) as error:
                                await apply_permission_decision(db, review["id"], "approved", "test-admin", "Checked ID", valid_for_minutes=duration)
                            self.assertEqual(error.exception.status_code, 422)
                            await db.rollback()
                async with self.sessions() as db:
                    self.assertEqual((await db.get(PermissionRequestModel, review["id"])).data, saved)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), movement_count)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), audit_count)
                    if presence:
                        state = await db.get(PresenceState, saved["subjectId"])
                        self.assertEqual((state.state, state.last_scan_timestamp, state.entry_override), presence)
                    else:
                        # Approval creates the registered identity but does not
                        # admit it or create presence until the one-time rescan.
                        subject = await db.scalar(select(Subject).where(Subject.barcode == "invalid-duration"))
                        if status == "pending":
                            self.assertIsNone(subject)
                        else:
                            self.assertIsNotNone(subject)
                if status == "pending":
                    approved = await self.client.post(url, json={
                        "decision": "approved", "reason": "Checked ID", "valid_for_minutes": 15,
                    })
                    self.assertEqual(approved.status_code, 200, approved.text)

    async def test_expired_manual_approval_cannot_start_entry_but_allows_exit_after_a_valid_rescan(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            body, review = await self._submit_unknown_manual_review("expired-manual-window")
            url = f"/v1/permission-requests/{review['id']}/decide"
            approved = await self.client.post(url, json={
                "decision": "approved", "reason": "Checked ID", "valid_for_minutes": 15,
            })
            self.assertEqual(approved.status_code, 200, approved.text)
            request = approved.json()["request"]
            subject_id = request["subjectId"]
            valid_to = datetime.fromisoformat(request["validTo"])
            entry_at = valid_to - timedelta(seconds=5)
            expired_at = valid_to + timedelta(seconds=1)
            async with self.sessions() as db:
                state = await db.get(PresenceState, subject_id)
                self.assertIsNone(state)
                self.assertFalse((await db.get(Person, subject_id)).data["inside"])
            with patch("movement_logic.datetime", wraps=datetime) as policy_clock, \
                 patch("terminal_scans.datetime", wraps=datetime) as scan_clock:
                policy_clock.now.return_value = entry_at
                scan_clock.now.return_value = entry_at
                entered = await self.client.post("/v1/terminal/scans", json=body,
                    headers={"Idempotency-Key": str(uuid.uuid4())})
                self.assertEqual(entered.status_code, 200, entered.text)
                self.assertTrue(entered.json()["allowed"], entered.text)
                self.assertEqual(entered.json()["manualApprovalRequest"]["id"], review["id"])
                policy_clock.now.return_value = expired_at
                scan_clock.now.return_value = expired_at
                exited = await self.client.post("/v1/terminal/scans", json=body,
                    headers={"Idempotency-Key": str(uuid.uuid4())})
                self.assertEqual(exited.status_code, 200, exited.text)
                self.assertTrue(exited.json()["allowed"])
                self.assertEqual(exited.json()["decision"]["event"]["direction"], "exit")
                policy_clock.now.return_value = expired_at + timedelta(seconds=11)
                scan_clock.now.return_value = expired_at + timedelta(seconds=11)
                denied = await self.client.post("/v1/terminal/scans", json=body,
                    headers={"Idempotency-Key": str(uuid.uuid4())})
                self.assertEqual(denied.status_code, 200, denied.text)
                self.assertFalse(denied.json()["allowed"])
                self.assertNotEqual(denied.json()["reason"], "Cooldown active")
            retried = await self.client.post(url, json={
                "decision": "approved", "reason": "Checked ID", "valid_for_minutes": 240,
            })
            self.assertEqual(retried.status_code, 200, retried.text)
            self.assertEqual(retried.json()["request"]["validFrom"], request["validFrom"])
            self.assertEqual(retried.json()["request"]["validTo"], request["validTo"])
            async with self.sessions() as db:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "outside")
                self.assertIsNone(state.entry_override)
                self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)
                    .where(Movement.data["manualApprovalRequestId"].astext == review["id"])), 1)
                self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)

    async def test_manual_unknown_entry_persists_and_exits_once(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        scan_body = {"barcode": "new-visitor", "checkpointId": "cp-main"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            denied = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertEqual(denied.status_code, 200, denied.text)
            self.assertFalse(denied.json()["allowed"])
            review = await self.client.post("/v1/terminal/manual-reviews", json={
                **scan_body,
                "direction": "entry",
                "eventId": denied.json()["decision"]["event"]["id"],
                "operatorNote": "Verified photo ID at the gate.",
            })
            self.assertEqual(review.status_code, 200, review.text)
            self.assertEqual(review.json()["operatorNote"], "Verified photo ID at the gate.")
            url = f"/v1/permission-requests/{review.json()['id']}/decide"
            no_note = await self.client.post(url, json={"decision": "denied"})
            self.assertEqual(no_note.status_code, 422, no_note.text)
            approval = {"decision": "approved", "admin_id": "spoofed", "reason": "Checked ID"}
            response = await self.client.post(url, json=approval)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertFalse(result["workflowSignaled"])
            subject_id = result["request"]["subjectId"]
            async with self.sessions() as db:
                self.assertEqual((await db.get(Subject, subject_id)).barcode, "new-visitor")
                self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                state = await db.get(PresenceState, subject_id)
                self.assertIsNone(state)
                self.assertEqual(result["auditEvent"]["actor"], "test-admin")
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
                resolved = await db.get(Movement, denied.json()["decision"]["event"]["id"])
                self.assertEqual(resolved.result, "denied")
                self.assertEqual(resolved.scan_type, "auto")
            # Approval only prepares a pass; the terminal must rescan to admit.
            entry_response = await self.client.post("/v1/terminal/scans", json=scan_body,
                headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertTrue(entry_response.json()["allowed"], entry_response.text)
            self.assertEqual(entry_response.json()["decision"]["event"]["scanType"], "manual")
            self.assertEqual(entry_response.json()["decision"]["event"]["manualApprovalRequestId"], review.json()["id"])
            async with self.sessions() as db:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "inside")
                self.assertEqual(state.entry_override["requestId"], review.json()["id"])
                self.assertTrue(state.entry_override["validTo"])
                self.assertTrue((await db.get(Person, subject_id)).data["inside"])
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement).where(
                    Movement.data["manualApprovalRequestId"].astext == review.json()["id"])), 1)
            exit_response = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertEqual(exit_response.status_code, 200, exit_response.text)
            self.assertTrue(exit_response.json()["allowed"], exit_response.text)
            self.assertEqual(exit_response.json()["decision"]["event"]["direction"], "exit")
            retry = await self.client.post(url, json=approval)
            self.assertEqual(retry.status_code, 200, retry.text)
            self.assertEqual(retry.json()["request"]["validTo"], result["request"]["validTo"])
            async with self.sessions() as db:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "outside")
                self.assertIsNone(state.entry_override)
                self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement).where(
                    Movement.data["manualApprovalRequestId"].astext == review.json()["id"])), 1)
                state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
                await db.commit()
            reentry = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertFalse(reentry.json()["allowed"])
            conflict = await self.client.post(url, json={**approval, "decision": "denied"})
            self.assertEqual(conflict.status_code, 409)

    async def test_manual_denial_reclassifies_original_scan_in_history_and_analytics(self):
        from routers.dashboard import get_dashboard
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "unknown-manual-denial", "checkpointId": "cp-main"}
        key = str(uuid.uuid4())
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()) as publish, \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            scan = await self.client.post("/v1/terminal/scans", json=body, headers={"Idempotency-Key": key})
            self.assertEqual(scan.status_code, 200, scan.text)
            source = scan.json()["decision"]["event"]
            self.assertEqual((source["result"], source["scanType"]), ("denied", "auto"))
            review = await self.client.post("/v1/terminal/manual-reviews", json={
                **body, "eventId": source["id"], "direction": "entry", "operatorNote": "No valid identification",
            })
            self.assertEqual(review.status_code, 200, review.text)
            url = f"/v1/permission-requests/{review.json()['id']}/decide"
            decision = {"decision": "denied", "reason": "Identification could not be verified"}
            response = await self.client.post(url, json=decision)
            self.assertEqual(response.status_code, 200, response.text)
            event = response.json()["movement"]
            self.assertEqual((event["id"], event["result"], event["scanType"]), (source["id"], "denied", "manual"))
            self.assertEqual(event["createdAt"], source["createdAt"])
            self.assertEqual(event["initialScanType"], "auto")
            self.assertEqual(event["denialCode"], "manual_review")
            published = json.loads(publish.call_args.args[0])
            self.assertEqual(published["movement"]["scanType"], "manual")
            retry = await self.client.post(url, json=decision)
            self.assertEqual(retry.status_code, 200, retry.text)
            self.assertEqual(retry.json()["movement"], event)
            # An original scan retry retains its immutable response, not a new event.
            replay = await self.client.post("/v1/terminal/scans", json=body, headers={"Idempotency-Key": key})
            self.assertEqual(replay.json(), scan.json())
        for endpoint in ("/v1/movements", "/v1/movements/analytics"):
            manual = await self.client.get(endpoint, params={"scanType": "manual", "result": "denied"})
            automatic = await self.client.get(endpoint, params={"scanType": "auto", "result": "denied"})
            self.assertEqual(manual.status_code, 200, manual.text)
            self.assertEqual(automatic.status_code, 200, automatic.text)
            self.assertEqual(len(manual.json()["items"]), 1)
            self.assertEqual(automatic.json()["items"], [])
        async with self.sessions() as db:
            saved = await db.get(Movement, source["id"])
            self.assertEqual((saved.scan_type, saved.result), ("manual", "denied"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(PresenceState)), 0)
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == body["barcode"])))
            dashboard = await get_dashboard(db)
            self.assertEqual(dashboard["analytics"]["totalScans"], 1)
            self.assertEqual(dashboard["analytics"]["totalAutomatic"], 0)
            self.assertEqual(dashboard["analytics"]["totalManual"], 1)
            self.assertEqual(dashboard["analytics"]["totalDenied"], 1)

    async def test_review_classification_migration_preserves_events_presence_and_retry_snapshot(self):
        now = datetime.now(timezone.utc)
        key = uuid.uuid4()
        original_response = {"allowed": False, "decision": {"event": {"id": "review-denied", "scanType": "auto"}}}
        async with self.sessions() as db:
            for result in ("approved", "denied"):
                event_id = "review-" + result
                db.add(Movement(id=event_id, subject_id="p1", checkpoint_id="cp-main", occurred_at=now,
                    result=result, direction="entry", scan_type="auto", subject_type="employee", sync_state="synced",
                    data={"id": event_id, "result": result, "scanType": "auto", "reason": "Reviewed decision",
                          "overrideRequestId": "req-" + result, "manualReviewedAt": now.isoformat()}))
            db.add(Movement(id="ordinary-denial", subject_id="p1", checkpoint_id="cp-main", occurred_at=now,
                result="denied", direction="entry", scan_type="auto", subject_type="employee", sync_state="synced",
                data={"id": "ordinary-denial", "scanType": "auto", "overrideRequestId": "pending-review"}))
            db.add(PresenceState(subject_id="p1", state="inside", last_scan_timestamp=now, entry_override={"requestId": "existing-visit"}))
            db.add(ScanRequest(idempotency_key=key, subject_id="p1", terminal_id="operator", status_code=200,
                response_body=original_response, request_fingerprint="unchanged-fingerprint"))
            await db.commit()
        async with self.engine.begin() as conn:
            def correct(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                with Operations.context(MigrationContext.configure(connection)):
                    scripts.get_revision("q5r6s7t8u9").module.upgrade()
                    scripts.get_revision("q5r6s7t8u9").module.upgrade()
            await conn.run_sync(correct)
        async with self.sessions() as db:
            for result in ("approved", "denied"):
                event = await db.get(Movement, "review-" + result)
                self.assertEqual((event.scan_type, event.data["scanType"], event.data["initialScanType"]), ("manual", "manual", "auto"))
                self.assertEqual((event.result, event.occurred_at, event.data["reason"]), (result, now, "Reviewed decision"))
            ordinary = await db.get(Movement, "ordinary-denial")
            self.assertEqual((ordinary.scan_type, ordinary.data["scanType"]), ("auto", "auto"))
            state = await db.get(PresenceState, "p1")
            self.assertEqual((state.state, state.last_scan_timestamp, state.entry_override), ("inside", now, {"requestId": "existing-visit"}))
            snapshot = await db.get(ScanRequest, key)
            self.assertEqual((snapshot.response_body, snapshot.request_fingerprint), (original_response, "unchanged-fingerprint"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 3)

    async def test_terminal_notification_dismissal_preserves_decision_and_history(self):
        from auth import verify_admin_or_operator_request
        operator = {"sub": "test-operator", "realm_access": {"roles": ["operator"]}}
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: operator
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: operator
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            await db.commit()
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            for outcome in ("denied", "approved"):
                with self.subTest(outcome=outcome):
                    async with self.sessions() as db:
                        scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
                        await db.commit()
                        req_id = await self._create_review(db, "p1", "p1", scan["decision"]["event"])
                    url = f"/v1/permission-requests/{req_id}"
                    decided = await self.client.post(url + "/decide", json={"decision": outcome, "reason": "ID checked"})
                    self.assertEqual(decided.status_code, 200, decided.text)
                    self.assertNotIn("terminalAcknowledgementRequired", decided.json()["request"])
                    async with self.sessions() as db:
                        movement = dict((await db.get(Movement, scan["decision"]["event"]["id"])).data)
                        person = dict((await db.get(Person, "p1")).data)
                        state = await db.get(PresenceState, "p1")
                        presence = (state.state, state.last_scan_timestamp, state.entry_override)
                        counts = [await db.scalar(select(func.count()).select_from(model))
                                  for model in (Movement, AuditEvent, AccessPermission, ScanRequest)]
                    # Event publication can fail after a successful optional dismissal.
                    with patch("routers.permissions.publish_presence_update", new=AsyncMock(side_effect=RuntimeError("offline"))) as publish:
                        dismissed = await self.client.post(url + "/dismiss")
                        self.assertEqual(dismissed.status_code, 200, dismissed.text)
                        notice = dismissed.json()
                        self.assertEqual((notice["status"], notice["decidedAt"], notice["decisionReason"]),
                                         (outcome, decided.json()["request"]["decidedAt"], "ID checked"))
                        self.assertEqual(notice["notificationDismissedBy"], "test-operator")
                        self.assertTrue(notice["notificationDismissedAt"])
                        retry = await self.client.post(url + "/dismiss")
                        self.assertEqual(retry.json(), notice)
                        publish.assert_awaited_once()
                    bundle = await self.client.get("/v1/terminal/bundle")
                    self.assertEqual(bundle.status_code, 200, bundle.text)
                    self.assertEqual(next(item for item in bundle.json()["permissionRequests"] if item["id"] == req_id), notice)
                    async with self.sessions() as db:
                        self.assertEqual((await db.get(Movement, scan["decision"]["event"]["id"])).data, movement)
                        self.assertEqual((await db.get(Person, "p1")).data, person)
                        state = await db.get(PresenceState, "p1")
                        self.assertEqual((state.state, state.last_scan_timestamp, state.entry_override), presence)
                        self.assertEqual([await db.scalar(select(func.count()).select_from(model))
                                          for model in (Movement, AuditEvent, AccessPermission, ScanRequest)], counts)
                        self.assertEqual((await db.get(PermissionRequestModel, req_id)).data, notice)

    async def test_terminal_notification_dismissal_requires_assigned_checkpoint(self):
        from auth import verify_admin_or_operator_request
        actor = {"sub": "operator", "realm_access": {"roles": ["operator"]}}
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: actor
        async with self.sessions() as db:
            req_id = await self._create_review(db)
            request = await db.get(PermissionRequestModel, req_id)
            original = {**request.data, "status": "denied", "checkpointId": "server-room", "decisionReason": "No ID"}
            request.data = original
            await db.commit()
        url = f"/v1/permission-requests/{req_id}/dismiss"
        forbidden = await self.client.post(url)
        self.assertEqual(forbidden.status_code, 403, forbidden.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(PermissionRequestModel, req_id)).data, original)
            assignment = await db.get(TerminalCheckpointAssignment, "browser:operator")
            assignment.checkpoint_id = "server-room"
            await db.commit()
        with patch("routers.permissions.publish_presence_update", new=AsyncMock()) as publish:
            accepted = await self.client.post(url)
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual(json.loads(publish.call_args.args[0])["type"], "terminal_notification_dismissed")
            async with self.sessions() as db:
                await db.delete(await db.get(TerminalCheckpointAssignment, "browser:operator"))
                await db.commit()
            self.assertEqual((await self.client.post(url)).status_code, 403)
            publish.assert_awaited_once()
        actor = {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        pending_id = None
        async with self.sessions() as db:
            pending_id = await self._create_review(db, "pending-notice")
            visitor_id = await self._create_review(db, "visitor-notice", kind="visitor")
        self.assertEqual((await self.client.post(f"/v1/permission-requests/{pending_id}/dismiss")).status_code, 409)
        self.assertEqual((await self.client.post(f"/v1/permission-requests/{visitor_id}/dismiss")).status_code, 422)
        self.assertEqual((await self.client.post("/v1/permission-requests/missing/dismiss")).status_code, 404)
        self.assertEqual((await self.client.post(url.replace("/dismiss", "/acknowledge"))).status_code, 404)
        # An unassigned administrator may dismiss a completed notice, preserving attribution.
        self.assertEqual((await self.client.post(url)).json(), accepted.json())
        del self.app.dependency_overrides[verify_admin_or_operator_request]
        self.assertEqual((await self.client.post(url)).status_code, 401)

    async def test_terminal_notification_migration_preserves_legacy_dismissal_and_decisions(self):
        now = datetime.now(timezone.utc).isoformat()
        async with self.sessions() as db:
            closed = await self._create_review(db, "closed-notice")
            open_notice = await self._create_review(db, "open-notice")
            req = await db.get(PermissionRequestModel, closed)
            original = {**req.data, "status": "denied", "decidedAt": now, "decisionReason": "No ID"}
            req.data = {**original, "terminalAcknowledgementRequired": True, "acknowledgedAt": now, "acknowledgedBy": "old-operator"}
            other = await db.get(PermissionRequestModel, open_notice)
            other.data = {**other.data, "status": "approved", "terminalAcknowledgementRequired": True}
            await db.commit()
        async with self.engine.begin() as conn:
            def migrate(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                with Operations.context(MigrationContext.configure(connection)):
                    scripts.get_revision("r6s7t8u9v0").module.upgrade()
                    scripts.get_revision("r6s7t8u9v0").module.upgrade()
            await conn.run_sync(migrate)
        async with self.sessions() as db:
            migrated = (await db.get(PermissionRequestModel, closed)).data
            self.assertEqual(migrated, {**original, "notificationDismissedAt": now, "notificationDismissedBy": "old-operator"})
            visible = (await db.get(PermissionRequestModel, open_notice)).data
            self.assertEqual(visible["status"], "approved")
            for field in ("terminalAcknowledgementRequired", "acknowledgedAt", "acknowledgedBy", "notificationDismissedAt"):
                self.assertNotIn(field, visible)

    async def test_manual_approval_preserves_carried_hardware_and_allows_matching_exit(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "different-person"}
            await db.commit()
            payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"])
            denied = await record_scan(db, uuid.uuid4(), payload, "test")
            await db.commit()
            req_id = await self._create_review(db, "p1", "p1", denied["decision"]["event"])
            approved = await apply_permission_decision(db, req_id, "approved", "admin", "Checked custody")
            await db.commit()
            self.assertIsNone(approved["movement"])
            self.assertFalse((await db.get(Person, "p1")).data["inside"])
            self.assertFalse((await db.get(HardwareAsset, "h1")).data["inside"])
            entry = await record_scan(db, uuid.uuid4(), payload, "test")
            self.assertTrue(entry["allowed"], entry)
            self.assertEqual(entry["decision"]["event"]["hardwareIds"], ["h1"])
            self.assertEqual(entry["decision"]["event"]["manualApprovalRequestId"], req_id)
            self.assertTrue((await db.get(HardwareAsset, "h1")).data["inside"])
            await db.commit()
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), payload, "test")
            self.assertTrue(result["allowed"], result)
            await db.commit()
            for subject_id in ["p1", "h1"]:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "outside")
                self.assertIsNone(state.entry_override)

    async def test_concurrent_approval_creates_one_identity_without_admitting_it(self):
        async with self.sessions() as db:
            req_id = await self._create_review(db)
        async def decide():
            async with self.sessions() as db:
                result = await apply_permission_decision(db, req_id, "approved", "admin", "Checked")
                await db.commit()
                return result
        results = await asyncio.gather(decide(), decide())
        self.assertEqual(results[0]["request"]["subjectId"], results[1]["request"]["subjectId"])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)
            self.assertIsNone(await db.get(PresenceState, results[0]["request"]["subjectId"]))
            self.assertFalse((await db.get(Person, results[0]["request"]["subjectId"])).data["inside"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)

    async def test_stale_activity_cannot_reverse_either_decision(self):
        async with self.sessions() as db:
            denied_id = await self._create_review(db)
            await apply_permission_decision(db, denied_id, "denied", "admin", "No ID")
            await db.commit()
            stale = await apply_permission_decision(db, denied_id, "approved", "system", "stale", from_activity=True)
            await db.commit()
            self.assertEqual(stale["request"]["status"], "denied")
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "unknown-1")))
            approved_id = await self._create_review(db, "unknown-2")
            await apply_permission_decision(db, approved_id, "approved", "admin", "Checked")
            await db.commit()
            stale = await apply_permission_decision(db, approved_id, "denied", "system", "timeout", from_activity=True)
            self.assertEqual(stale["request"]["status"], "approved")

    async def test_failed_approval_rolls_back_request_and_new_identity(self):
        from fastapi import HTTPException
        async with self.sessions() as db:
            req_id = await self._create_review(db)
            req = await db.get(PermissionRequestModel, req_id)
            req.data = {**req.data, "checkpointId": "missing"}
            await db.commit()
            with self.assertRaises(HTTPException):
                await apply_permission_decision(db, req_id, "approved", "admin", "Checked")
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(PermissionRequestModel, req_id)).data["status"], "pending")
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "unknown-1")))

    async def test_visitor_permission_is_applied_without_temporal_and_survives_timeout(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            db.add(Subject(id="v1", kind="visitor", barcode="visitor", person=Person(data={"name": "Visitor", "status": "pending_approval", "type": "visitor"})))
            await db.commit()
            req_id = await self._create_review(db, "visitor", "v1", kind="visitor")
        with patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock(side_effect=RuntimeError("offline"))):
            response = await self.client.post(f"/v1/permission-requests/{req_id}/decide", json={
                "decision": "approved",
                "admin_id": "admin",
                "reason": "Visitor identity and host were verified.",
            })
            self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(Person, "v1")).data["status"], "pre_approved")
            self.assertEqual((await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == "v1"))).data["state"], "active")
            await apply_permission_decision(db, req_id, "denied", "system", "timeout", from_activity=True)
            await db.commit()
            self.assertEqual((await db.get(Person, "v1")).data["status"], "pre_approved")

    async def test_historical_manual_entry_repair_is_idempotent_and_keeps_later_exits(self):
        from repair_manual_entries import repair_manual_entries
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            req_id = await self._create_review(db, "legacy")
            req = await db.get(PermissionRequestModel, req_id)
            req.data = {**req.data, "status": "approved"}
            db.add(Movement(id="legacy-entry", subject_id=None, checkpoint_id="cp-main", occurred_at=now,
                result="approved", direction="entry", scan_type="manual", subject_type="visitor", sync_state="queued",
                data={"id": "legacy-entry", "barcode": "legacy", "subjectId": "unregistered", "subjectName": "Legacy visitor", "overrideRequestId": req_id}))
            await db.commit()
            check = await repair_manual_entries(db)
            self.assertEqual(check["unlinkedMovements"], 1)
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "legacy")))
            applied = await repair_manual_entries(db, apply=True)
            await db.commit()
            self.assertEqual(applied["unlinkedMovements"], 1)
        async with self.sessions() as db:
            movement = await db.get(Movement, "legacy-entry")
            state = await db.get(PresenceState, movement.subject_id)
            self.assertEqual(state.state, "inside")
            self.assertEqual(state.entry_override["requestId"], req_id)
            repeated = await repair_manual_entries(db, apply=True)
            await db.commit()
            self.assertEqual(repeated["unlinkedMovements"], 0)
            self.assertEqual(repeated["presenceRepairs"], 0)
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="legacy", checkpointId="cp-main"), "test")
            self.assertTrue(result["allowed"], result)
            await db.commit()
        async with self.sessions() as db:
            repeated = await repair_manual_entries(db, apply=True)
            await db.commit()
            self.assertEqual(repeated["presenceRepairs"], 0)
            subject = await db.scalar(select(Subject).where(Subject.barcode == "legacy"))
            self.assertEqual((await db.get(PresenceState, subject.id)).state, "outside")

    async def test_registry_creates_permissions_and_preserves_selected_zones(self):
        from auth import verify_admin_or_operator_request
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        for kind in ["employee", "hardware"]:
            response = await self.client.post("/v1/registry/subjects", json={"barcode": "  new-" + kind + "  ", "kind": kind,
                "data": {"name": "New subject", "allowedZone": "public", "category": "Laptop", "status": "active"}})
            self.assertEqual(response.status_code, 201, response.text)
            subject_id = response.json()["id"]
            async with self.sessions() as db:
                permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject_id))
                self.assertEqual(permission.data["zones"], ["public"])
                self.assertEqual(permission.data["state"], "active")
                scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="new-" + kind, checkpointId="cp-main"), "test")
                self.assertTrue(scan["allowed"], scan)
                await db.commit()

    async def test_alerts_with_absent_optional_fields_remain_visible(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Alert(id="visible", created_at=now, data={"id": "visible", "title": "Restricted access", "status": "open"}))
            db.add(Alert(id="review", created_at=now, data={"id": "review", "manualReview": True, "status": "open"}))
            db.add(Movement(
                id="registry-movement",
                subject_id="p1",
                checkpoint_id="cp-main",
                occurred_at=now,
                result="approved",
                direction="entry",
                scan_type="manual",
                subject_type="employee",
                sync_state="synced",
                data={"id": "registry-movement", "subjectName": "Alice", "barcode": "p1"},
            ))
            db.add(AuditEvent(
                id="registry-audit",
                created_at=now,
                data={"id": "registry-audit", "category": "permission", "action": "Granted"},
            ))
            await db.commit()
        response = await self.client.get("/v1/alerts")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in response.json()["items"]], ["visible"])
        bundle = await self.client.get("/v1/registry/bundle")
        self.assertEqual([item["id"] for item in bundle.json()["alerts"]], ["visible"])
        self.assertEqual([item["id"] for item in bundle.json()["movements"]], ["registry-movement"])
        self.assertEqual([item["id"] for item in bundle.json()["auditEvents"]], ["registry-audit"])

    async def test_review_deduplication_and_source_validation(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}
        async with self.sessions() as db:
            denial = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="unknown-review", checkpointId="cp-main"), "test")
            await db.commit()
        body = {
            "barcode": "unknown-review",
            "checkpointId": "cp-main",
            "direction": "entry",
            "eventId": denial["decision"]["event"]["id"],
            "operatorNote": "Verified at the gate before requesting review.",
        }
        with patch("routers.terminal.get_temporal_client", new=AsyncMock()), patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            first, second = await asyncio.gather(*[self.client.post("/v1/terminal/manual-reviews", json=body) for _ in range(2)])
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()["id"], second.json()["id"])
            bad = await self.client.post("/v1/terminal/manual-reviews", json={**body, "barcode": "someone-else"})
            self.assertEqual(bad.status_code, 422)

    async def test_hardware_scan_cannot_move_unrelated_assets(self):
        from fastapi import HTTPException
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp-main", selectedHardwareIds=["h1"]), "test")
            self.assertEqual(error.exception.status_code, 422)

    async def test_profile_isolation_and_explicit_availability(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-a", "name": "Admin A", "email": "a@example.test"}
        first = await self.client.get("/v1/admin/profile")
        self.assertEqual(first.status_code, 200, first.text)
        updated = await self.client.patch("/v1/admin/profile", json={"avatarDataUrl": "data:image/png;base64,dGVzdA=="})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["avatar_data_url"], "data:image/png;base64,dGVzdA==")
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-b", "name": "Admin B", "email": "b@example.test"}
        second = await self.client.get("/v1/admin/profile")
        self.assertNotEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(second.json()["name"], "Admin B")
        self.assertEqual(second.json()["avatar_data_url"], "")
        self.assertEqual(second.json()["settings"], {"requireReviewNote": True})
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-a"}
        again = await self.client.get("/v1/admin/profile")
        self.assertEqual(again.json()["offline_until"], None)
        expected_return = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        offline = await self.client.patch("/v1/admin/profile/availability", json={"offlineUntil": expected_return})
        self.assertEqual(offline.status_code, 200, offline.text)
        self.assertIsNotNone(offline.json()["offline_until"])
        cleared = await self.client.patch("/v1/admin/profile/availability", json={"offlineUntil": None})
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertIsNone(cleared.json()["offline_until"])
        invalid = await self.client.patch("/v1/admin/profile/availability", json={"offlineUntil": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()})
        self.assertEqual(invalid.status_code, 422, invalid.text)

    async def test_retired_employee_metadata_stays_absent_in_http_writes_reads_and_scans(self):
        from auth import verify_admin_or_operator_request
        actor = {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: actor
        self.app.dependency_overrides[verify_admin_request] = lambda: actor
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "type": "visitor", "department": "Operations", "accessLevel": "Elevated"}
            await db.commit()
        for path in ("/v1/registry/subjects/p1", "/v1/registry/subjects", "/v1/registry/bundle", "/v1/permissions"):
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn('"department"', response.text)
            self.assertNotIn('"accessLevel"', response.text)
        created = await self.client.post("/v1/registry/subjects", json={"kind": "employee", "barcode": "employee-cleanup", "data": {
            "name": "New employee", "allowedZones": ["secure"], "department": {"stale": True}, "accessLevel": "Standard"}})
        self.assertEqual(created.status_code, 201, created.text)
        self.assertNotIn("department", created.json()["data"])
        self.assertNotIn("accessLevel", created.json()["data"])
        self.assertEqual(created.json()["data"]["allowedZones"], ["secure"])
        updated = await self.client.put("/v1/registry/subjects/p1", json={"data": {
            "department": "Reintroduced", "accessLevel": "Admin", "allowedZones": ["public"]}})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertNotIn("department", updated.json()["data"])
        self.assertNotIn("accessLevel", updated.json()["data"])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Person, "p1")).data["allowedZones"], ["public"])
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
            self.assertTrue(result["allowed"])
            self.assertNotIn("department", result["decision"]["subject"])
            self.assertNotIn("accessLevel", result["updatedPeople"][0])
            await db.commit()

    async def test_retired_employee_metadata_migration_cleans_only_current_employee_rows(self):
        legacy = {"department": "Operations", "accessLevel": "Elevated"}
        now = datetime.now(timezone.utc)
        key = uuid.uuid4()
        snapshot = {"person": {"id": "p1", "type": "employee", **legacy}}
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            original = {**person.data, "type": "visitor", **legacy}
            person.data = original
            db.add(Subject(id="visitor-keep", kind="visitor", barcode="visitor-keep", person=Person(data={"name": "Guest", **legacy})))
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "owner": "Alice"}
            db.add(AuditEvent(id="retired-fields-audit", created_at=now, data=snapshot))
            db.add(ScanRequest(idempotency_key=key, subject_id="p1", terminal_id="operator", status_code=200,
                response_body=snapshot, request_fingerprint="unchanged"))
            await db.commit()
        for _ in range(2):
            async with self.engine.begin() as conn:
                def migrate(connection):
                    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                    with Operations.context(MigrationContext.configure(connection)):
                        scripts.get_revision("v0w1x2y3z4").module.upgrade()
                await conn.run_sync(migrate)
        async with self.sessions() as db:
            self.assertEqual((await db.get(Person, "p1")).data, {key: value for key, value in original.items() if key not in legacy})
            self.assertEqual((await db.get(Person, "visitor-keep")).data, {"name": "Guest", **legacy})
            self.assertEqual((await db.get(HardwareAsset, "h1")).data["owner"], "Alice")
            self.assertEqual((await db.get(AuditEvent, "retired-fields-audit")).data, snapshot)
            cached = await db.get(ScanRequest, key)
            self.assertEqual((cached.response_body, cached.request_fingerprint), (snapshot, "unchanged"))

    async def test_registry_updates_cascade_to_permissions_and_keep_identity_consistent(self):
        from auth import verify_admin_or_operator_request
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        created = await self.client.post("/v1/registry/subjects", json={"kind": "employee", "barcode": "edit-me", "data": {"name": "Employee", "allowedZone": "public"}})
        self.assertEqual(created.status_code, 201, created.text)
        subject_id = created.json()["id"]
        updated = await self.client.put(f"/v1/registry/subjects/{subject_id}", json={"barcode": "new-code", "data": {"id": "spoofed", "status": "restricted", "inside": True}})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["data"]["id"], subject_id)
        self.assertFalse(updated.json()["data"]["inside"])
        async with self.sessions() as db:
            self.assertEqual((await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject_id))).data["state"], "restricted")
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="new-code", checkpointId="cp-main"), "test")
            self.assertFalse(denied["allowed"])
            await db.commit()
        bundle = await self.client.get("/v1/registry/bundle")
        item = next(item for item in bundle.json()["people"] if item["id"] == subject_id)
        self.assertEqual(item["barcode"], "new-code")

    async def test_same_scan_key_rejects_changed_payload(self):
        from fastapi import HTTPException
        key = uuid.uuid4()
        async with self.sessions() as db:
            await record_scan(db, key, BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
            await db.commit()
            with self.assertRaises(HTTPException) as error:
                await record_scan(db, key, BrowserScanPayload(barcode="h1", checkpointId="cp-main"), "test")
            self.assertEqual(error.exception.status_code, 409)

    async def test_invalid_permission_grants_cannot_corrupt_saved_access(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            db.add(AccessPermission(id="perm-p1", subject_id="p1", data={"id": "perm-p1", "subjectId": "p1", "state": "active", "zones": ["public"]}))
            await db.commit()
        # The former generic patch route is retired; validate the current grant
        # API instead of expecting field validation from a nonexistent endpoint.
        self.assertEqual((await self.client.patch("/v1/permissions/p1", json={"state": "arbitrary"})).status_code, 404)
        now = datetime.now(timezone.utc)
        start = (now + timedelta(days=1)).isoformat()
        end = (now + timedelta(days=2)).isoformat()
        body = {"subject_id": "p1", "checkpoint_id": "cp-main", "request_type": "zone_access",
                "requested_zones": ["public"], "valid_from": start, "valid_to": end}
        for invalid in ({"request_type": "visitor"}, {"request_type": "hardware_custody"},
                        {"requested_zones": []}, {"requested_zones": "All Zones"}, {"requested_zones": ["unknown-zone"]},
                        {"valid_from": "bad-date"}, {"valid_to": start},
                        {"valid_to": (now + timedelta(days=365)).isoformat()}):
            response = await self.client.post("/v1/permissions/grant", json={**body, **invalid})
            self.assertEqual(response.status_code, 422, response.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(AccessPermission, "perm-p1")).data,
                {"id": "perm-p1", "subjectId": "p1", "state": "active", "zones": ["public"]})
            self.assertEqual(await db.scalar(select(func.count(PermissionRequestModel.id))), 0)
            self.assertEqual(await db.scalar(select(func.count(AuditEvent.id))), 0)

    async def test_notes_persist_and_blank_notes_are_rejected(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
            await db.commit()
        url = "/v1/movements/" + scan["decision"]["event"]["id"] + "/notes"
        saved = await self.client.post(url, json={"note": "  Checked at gate  "})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual((await self.client.get(url)).json(), ["Checked at gate"])
        self.assertEqual((await self.client.post(url, json={"note": "  "})).status_code, 422)

    async def test_retired_alert_rules_do_not_trigger(self):
        from rule_engine import evaluate_scheduled_rules

        generated = evaluate_scheduled_rules(
            [{"id": "rule-exit-balance", "conditionKey": "exit_balance", "enabled": True}],
            [],
            [],
            [],
            employees=[{"id": "p1", "name": "Alice", "type": "employee", "status": "active"}],
            now=datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(generated, [])

    async def test_custody_approval_updates_asset_without_forging_carrier_name(self):
        async with self.sessions() as db:
            req_id = await self._create_review(db, "h1", "h1", kind="hardware_custody")
            req = await db.get(PermissionRequestModel, req_id)
            req.data = {**req.data, "hardwareId": "h1", "carrierId": "p1", "carrierName": "Forged name"}
            await db.commit()
            result = await apply_permission_decision(db, req_id, "approved", "admin", "Checked")
            await db.commit()
            self.assertEqual(result["hardwareAsset"]["assignedEmployeeId"], "p1")
            self.assertEqual(result["hardwareAsset"]["assignedEmployeeName"], "Alice")
            self.assertEqual(result["hardwareAsset"]["id"], "h1")

    async def test_incomplete_registry_record_is_repaired_without_granting_access(self):
        from repair_manual_entries import repair_manual_entries
        async with self.sessions() as db:
            db.add(Subject(id="incomplete", barcode="incomplete", kind="visitor"))
            await db.commit()
            check = await repair_manual_entries(db)
            self.assertEqual(check["missingMetadata"], 1)
            self.assertIsNone(await db.get(Person, "incomplete"))
            await repair_manual_entries(db, apply=True)
            await db.commit()
        async with self.sessions() as db:
            person = await db.get(Person, "incomplete")
            self.assertEqual(person.data["status"], "restricted")
            self.assertTrue(person.data["requiresProfileReview"])
            permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == "incomplete"))
            self.assertEqual(permission.data["state"], "restricted")
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="incomplete", checkpointId="cp-main"), "test")
            self.assertFalse(result["allowed"])
            await db.commit()
            check = await repair_manual_entries(db)
            self.assertEqual(check["missingMetadata"], 0)
            self.assertEqual(check["missingPermissions"], 0)

    async def _consolidate_zones(self):
        async with self.engine.begin() as conn:
            def migrate(connection):
                scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
                with Operations.context(MigrationContext.configure(connection)):
                    scripts.get_revision("o3p4q5r6s7").module.upgrade()
            await conn.run_sync(migrate)

    async def test_duplicate_zone_migration_preserves_history_presence_and_retry_keys(self):
        now = datetime.now(timezone.utc)
        key = uuid.uuid4()
        async with self.sessions() as db:
            entrance = await db.get(Checkpoint, "cp-main")
            entrance.data = {**entrance.data, "mode": "manual"}
            db.add(Checkpoint(id="main-gate", data={"name": "Main Entrance", "zone": "public"}))
            db.add(Movement(id="legacy-zone-movement", subject_id="p1", checkpoint_id="main-gate", occurred_at=now,
                result="approved", direction="entry", scan_type="auto", subject_type="employee", sync_state="synced",
                data={"id": "legacy-zone-movement", "checkpointId": "main-gate", "checkpoint": "Main Entrance", "reason": "Evidence unchanged"}))
            db.add(PresenceState(subject_id="p1", state="inside", last_scan_timestamp=now,
                entry_override={"checkpointId": "main-gate", "requestId": "legacy-request"}))
            db.add(AccessPermission(id="legacy-zone-permission", subject_id="p1", data={"zones": ["All Zones"], "state": "active"}))
            db.add(PermissionRequestModel(id="legacy-request", subject_id="p1", created_at=now, data={"status": "pending", "type": "zone_access",
                "checkpointId": "main-gate", "requestedZones": ["Main Entrance"], "previousZones": ["All Zones"]}))
            db.add(ScanRequest(idempotency_key=key, terminal_id="operator", subject_id="p1", status_code=200,
                request_fingerprint="preserved-original-hash", response_body={"decision": {"event": {"id": "legacy-zone-movement", "checkpointId": "main-gate"}}}))
            await db.commit()
        await self._consolidate_zones()
        await self._consolidate_zones()
        from seed import seed_reference_data
        await seed_reference_data(self.engine)
        await seed_reference_data(self.engine)
        async with self.sessions() as db:
            checkpoints = (await db.execute(select(Checkpoint).order_by(Checkpoint.id))).scalars().all()
            self.assertEqual([item.id for item in checkpoints], ["cp-main", "server-room"])
            self.assertEqual(checkpoints[0].data["mode"], "manual")
            movement = await db.get(Movement, "legacy-zone-movement")
            self.assertEqual(movement.checkpoint_id, "cp-main")
            self.assertEqual(movement.data["checkpointId"], "cp-main")
            self.assertEqual(movement.occurred_at, now)
            self.assertEqual(movement.data["reason"], "Evidence unchanged")
            self.assertEqual(movement.result, "approved")
            self.assertEqual(await db.scalar(select(func.count(Movement.id))), 1)
            presence = await db.get(PresenceState, "p1")
            self.assertEqual((presence.state, presence.last_scan_timestamp), ("inside", now))
            self.assertEqual(presence.entry_override["checkpointId"], "cp-main")
            self.assertEqual((await db.get(AccessPermission, "legacy-zone-permission")).data["zones"], ["public", "secure"])
            request = await db.get(PermissionRequestModel, "legacy-request")
            self.assertEqual(request.data["requestedZones"], ["public"])
            self.assertEqual(request.data["previousZones"], ["public", "secure"])
            cached = await db.get(ScanRequest, key)
            self.assertEqual(cached.request_fingerprint, "preserved-original-hash")
            self.assertEqual(cached.response_body["decision"]["event"]["checkpointId"], "cp-main")

    async def test_old_alias_scan_replays_after_migration_without_another_movement(self):
        key = uuid.uuid4()
        payload = BrowserScanPayload(barcode="p1", checkpointId="main-gate")
        normalized = payload.model_dump(mode="json")
        normalized["barcode"] = payload.barcode.strip().lower()
        normalized["selected_hardware_ids"] = sorted(set(payload.selected_hardware_ids))
        old_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
        async with self.sessions() as db:
            first = await record_scan(db, key, payload, "operator")
            cached = await db.get(ScanRequest, key)
            cached.request_fingerprint = old_hash
            cached.response_body = {**cached.response_body, "decision": {**cached.response_body["decision"],
                "event": {**cached.response_body["decision"]["event"], "checkpointId": "main-gate"}}}
            db.add(Checkpoint(id="main-gate", data={"name": "Main Entrance", "zone": "public"}))
            await db.commit()
        await self._consolidate_zones()
        async with self.sessions() as db:
            retry = await record_scan(db, key, payload, "operator")
            self.assertEqual(retry["decision"]["event"]["id"], first["decision"]["event"]["id"])
            self.assertEqual(retry["decision"]["event"]["checkpointId"], "cp-main")
            canonical_retry = await record_scan(db, key, BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "operator")
            self.assertEqual(canonical_retry, retry)
            self.assertEqual(await db.scalar(select(func.count(Movement.id))), 1)
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")
            self.assertEqual((await db.get(ScanRequest, key)).request_fingerprint, old_hash)
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as error:
                await record_scan(db, key, payload, "different-operator")
            self.assertEqual(error.exception.status_code, 409)

    async def test_zone_migration_rejects_unsupported_live_access_without_partial_cleanup(self):
        async with self.sessions() as db:
            db.add(Checkpoint(id="main-gate", data={"name": "Main Entrance", "zone": "public"}))
            db.add(PermissionRequestModel(id="unknown-zone-request", subject_id="p1", created_at=datetime.now(timezone.utc),
                data={"status": "pending", "type": "zone_access", "requestedZones": ["IT Lab"]}))
            await db.commit()
        with self.assertRaisesRegex(RuntimeError, "Unsupported live zones"):
            await self._consolidate_zones()
        async with self.sessions() as db:
            self.assertIsNotNone(await db.get(Checkpoint, "main-gate"))
            self.assertEqual((await db.get(PermissionRequestModel, "unknown-zone-request")).data["requestedZones"], ["IT Lab"])
