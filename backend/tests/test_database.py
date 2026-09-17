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
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, Depends
from sqlalchemy import text, select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.engine import make_url
from database import get_db, get_read_db
from models import Subject, Person, HardwareAsset, Checkpoint, Movement, PresenceState, PermissionRequestModel, AccessPermission, AuditEvent, Alert, Notification
from schemas import BrowserScanPayload
from terminal_scans import record_scan
from auth import verify_admin_request, verify_terminal_operator_request
from routers import movements, terminal, permissions, registry, alerts, notifications, admin_profile
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
            db.add(Checkpoint(id="cp1", data={"id": "cp1", "name": "Main", "mode": "auto", "zone": "Office"}))
            db.add(Subject(id="p1", kind="employee", barcode="p1", person=Person(data={
                "name": "Alice", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            db.add(Subject(id="h1", kind="hardware", barcode="h1", hardware=HardwareAsset(data={
                "name": "Laptop", "category": "Laptop", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            await db.commit()
        self.app = FastAPI()
        self.app.include_router(movements.router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(terminal.router, dependencies=[Depends(verify_terminal_operator_request)])
        self.app.include_router(permissions.router)
        self.app.include_router(registry.router)
        self.app.include_router(registry.bundle_router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(alerts.router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(notifications.router, dependencies=[Depends(verify_admin_request)])
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

    async def test_browser_scan_retry_hardware_and_movement_filters(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_operator_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "p1", "checkpointId": "cp1", "selectedHardwareIds": ["h1"], "scanType": "auto", "online": True}
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
        page = await self.client.get("/v1/movements", params={"search": "Alice", "checkpoint": "Main", "scanType": "auto", "subjectGroup": "people", "pageSize": 1, "page": 2})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["total"], 2)
        self.assertEqual(len(page.json()["items"]), 1)
        for params in ({"search": "Missing"}, {"scanType": "manual"}, {"subjectGroup": "hardware"}, {"startAt": "2099-01-01T00:00:00Z"}, {"endAt": "2000-01-01T00:00:00Z"}):
            self.assertEqual((await self.client.get("/v1/movements", params=params)).json()["total"], 0)

    async def test_direct_hardware_scan_and_custody_denial(self):
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "someone-else"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp1", selectedHardwareIds=["h1"]), "test")
            self.assertFalse(denied["allowed"])
            self.assertEqual(denied["decision"]["event"]["denialCode"], "custody_mismatch")
            await db.commit()
            approved = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp1"), "test")
            self.assertTrue(approved["allowed"])
            self.assertEqual(approved["decision"]["event"]["subjectType"], "hardware")
            await db.commit()

    async def _create_review(self, db, barcode="unknown-1", subject_id=None, event=None, kind="manual_override"):
        now = datetime.now(timezone.utc)
        req_id = "REQ-" + uuid.uuid4().hex
        req = PermissionRequestModel(id=req_id, subject_id=subject_id, created_at=now, data={
            "id": req_id, "barcode": barcode, "subjectId": subject_id or "", "subjectName": "Reviewed visitor",
            "subjectType": "visitor", "type": kind, "status": "pending", "checkpointId": "cp1",
            "direction": "entry", "requestedZones": ["Office"], "validFrom": now.isoformat(),
            "validTo": (now + timedelta(hours=1)).isoformat(),
            **({"eventId": event["id"]} if event else {}),
        })
        db.add(req)
        await db.commit()
        return req_id

    async def test_manual_unknown_entry_persists_and_exits_once(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_operator_request] = lambda: {"sub": "test-operator"}
        scan_body = {"barcode": "new-visitor", "checkpointId": "cp1"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            denied = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertEqual(denied.status_code, 200, denied.text)
            self.assertFalse(denied.json()["allowed"])
            review = await self.client.post("/v1/terminal/manual-reviews", json={**scan_body, "direction": "entry", "eventId": denied.json()["decision"]["event"]["id"]})
            self.assertEqual(review.status_code, 200, review.text)
            url = f"/v1/permission-requests/{review.json()['id']}/decide"
            approval = {"decision": "approved", "admin_id": "spoofed", "reason": "Checked ID"}
            response = await self.client.post(url, json=approval)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertFalse(result["workflowSignaled"])
            subject_id = result["request"]["subjectId"]
            async with self.sessions() as db:
                self.assertEqual((await db.get(Subject, subject_id)).barcode, "new-visitor")
                self.assertTrue((await db.get(Person, subject_id)).data["inside"])
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "inside")
                self.assertEqual(state.entry_override["requestId"], review.json()["id"])
                self.assertEqual(result["auditEvent"]["actor"], "test-admin")
            # A fresh HTTP request must use the saved presence, including an immediate exit.
            exit_response = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertEqual(exit_response.status_code, 200, exit_response.text)
            self.assertTrue(exit_response.json()["allowed"], exit_response.text)
            self.assertEqual(exit_response.json()["decision"]["event"]["direction"], "exit")
            retry = await self.client.post(url, json=approval)
            self.assertEqual(retry.status_code, 200, retry.text)
            async with self.sessions() as db:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "outside")
                self.assertIsNone(state.entry_override)
                self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                self.assertEqual(await db.scalar(select(func.count()).select_from(Movement).where(Movement.data["overrideRequestId"].astext == review.json()["id"])), 1)
                state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
                await db.commit()
            reentry = await self.client.post("/v1/terminal/scans", json=scan_body, headers={"Idempotency-Key": str(uuid.uuid4())})
            self.assertFalse(reentry.json()["allowed"])
            conflict = await self.client.post(url, json={**approval, "decision": "denied"})
            self.assertEqual(conflict.status_code, 409)

    async def test_manual_approval_preserves_carried_hardware_and_allows_matching_exit(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "different-person"}
            await db.commit()
            payload = BrowserScanPayload(barcode="p1", checkpointId="cp1", selectedHardwareIds=["h1"])
            denied = await record_scan(db, uuid.uuid4(), payload, "test")
            await db.commit()
            req_id = await self._create_review(db, "p1", "p1", denied["decision"]["event"])
            approved = await apply_permission_decision(db, req_id, "approved", "admin", "Checked custody")
            await db.commit()
            self.assertEqual(approved["movement"]["hardwareIds"], ["h1"])
            self.assertTrue((await db.get(HardwareAsset, "h1")).data["inside"])
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), payload, "test")
            self.assertTrue(result["allowed"], result)
            await db.commit()
            for subject_id in ["p1", "h1"]:
                state = await db.get(PresenceState, subject_id)
                self.assertEqual(state.state, "outside")
                self.assertIsNone(state.entry_override)

    async def test_concurrent_approval_creates_one_identity_and_one_movement(self):
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
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
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
            response = await self.client.post(f"/v1/permission-requests/{req_id}/decide", json={"decision": "approved", "admin_id": "admin"})
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
            db.add(Movement(id="legacy-entry", subject_id=None, checkpoint_id="cp1", occurred_at=now,
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
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="legacy", checkpointId="cp1"), "test")
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
                "data": {"name": "New subject", "allowedZone": "Office", "category": "Laptop", "status": "active"}})
            self.assertEqual(response.status_code, 201, response.text)
            subject_id = response.json()["id"]
            async with self.sessions() as db:
                permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject_id))
                self.assertEqual(permission.data["zones"], ["Office"])
                self.assertEqual(permission.data["state"], "active")
                scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="new-" + kind, checkpointId="cp1"), "test")
                self.assertTrue(scan["allowed"], scan)
                await db.commit()

    async def test_alerts_with_absent_optional_fields_remain_visible(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Alert(id="visible", created_at=now, data={"id": "visible", "title": "Restricted access", "status": "open"}))
            db.add(Alert(id="review", created_at=now, data={"id": "review", "manualReview": True, "status": "open"}))
            db.add(Notification(id="unread-null", created_at=now, data={"id": "unread-null", "read": None}))
            await db.commit()
        response = await self.client.get("/v1/alerts")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in response.json()["items"]], ["visible"])
        bundle = await self.client.get("/v1/registry/bundle")
        self.assertEqual([item["id"] for item in bundle.json()["alerts"]], ["visible"])
        unread = await self.client.get("/v1/notifications?read=false")
        self.assertEqual([item["id"] for item in unread.json()], ["unread-null"])

    async def test_review_deduplication_and_source_validation(self):
        self.app.dependency_overrides[verify_terminal_operator_request] = lambda: {"sub": "operator"}
        async with self.sessions() as db:
            denial = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="unknown-review", checkpointId="cp1"), "test")
            await db.commit()
        body = {"barcode": "unknown-review", "checkpointId": "cp1", "direction": "entry", "eventId": denial["decision"]["event"]["id"]}
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
                await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp1", selectedHardwareIds=["h1"]), "test")
            self.assertEqual(error.exception.status_code, 422)

    async def test_profile_isolation_and_camel_case_preferences(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-a", "name": "Admin A", "email": "a@example.test"}
        first = await self.client.get("/v1/admin/profile")
        self.assertEqual(first.status_code, 200, first.text)
        updated = await self.client.patch("/v1/admin/profile", json={"avatarDataUrl": "data:image/png;base64,dGVzdA==", "autoLock": "30"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["auto_lock"], "30")
        self.assertEqual(updated.json()["avatar_data_url"], "data:image/png;base64,dGVzdA==")
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-b", "name": "Admin B", "email": "b@example.test"}
        second = await self.client.get("/v1/admin/profile")
        self.assertNotEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(second.json()["name"], "Admin B")
        self.assertEqual(second.json()["avatar_data_url"], "")
        self.assertEqual(second.json()["auto_lock"], "15")
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin-a"}
        again = await self.client.get("/v1/admin/profile")
        self.assertEqual(again.json()["auto_lock"], "30")

    async def test_registry_updates_cascade_to_permissions_and_keep_identity_consistent(self):
        from auth import verify_admin_or_operator_request
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        created = await self.client.post("/v1/registry/subjects", json={"kind": "employee", "barcode": "edit-me", "data": {"name": "Employee", "allowedZone": "Office"}})
        self.assertEqual(created.status_code, 201, created.text)
        subject_id = created.json()["id"]
        updated = await self.client.put(f"/v1/registry/subjects/{subject_id}", json={"barcode": "new-code", "data": {"id": "spoofed", "status": "restricted", "inside": True}})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["data"]["id"], subject_id)
        self.assertFalse(updated.json()["data"]["inside"])
        async with self.sessions() as db:
            self.assertEqual((await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject_id))).data["state"], "restricted")
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="new-code", checkpointId="cp1"), "test")
            self.assertFalse(denied["allowed"])
            await db.commit()
        bundle = await self.client.get("/v1/registry/bundle")
        item = next(item for item in bundle.json()["people"] if item["id"] == subject_id)
        self.assertEqual(item["barcode"], "new-code")

    async def test_same_scan_key_rejects_changed_payload(self):
        from fastapi import HTTPException
        key = uuid.uuid4()
        async with self.sessions() as db:
            await record_scan(db, key, BrowserScanPayload(barcode="p1", checkpointId="cp1"), "test")
            await db.commit()
            with self.assertRaises(HTTPException) as error:
                await record_scan(db, key, BrowserScanPayload(barcode="h1", checkpointId="cp1"), "test")
            self.assertEqual(error.exception.status_code, 409)

    async def test_invalid_permission_patch_cannot_corrupt_saved_access(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            db.add(AccessPermission(id="perm-p1", subject_id="p1", data={"id": "perm-p1", "subjectId": "p1", "state": "active", "zones": ["Office"]}))
            await db.commit()
        for patch in ({"state": "arbitrary"}, {"subjectId": "p2"}, {"zones": "All Zones"}, {"validFrom": "bad-date"}, {"validFrom": "2026-09-18", "validTo": "2026-09-17"}):
            response = await self.client.patch("/v1/permissions/p1", json=patch)
            self.assertEqual(response.status_code, 422, response.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(AccessPermission, "perm-p1")).data["state"], "active")

    async def test_notes_persist_and_blank_notes_are_rejected(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        async with self.sessions() as db:
            scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp1"), "test")
            await db.commit()
        url = "/v1/movements/" + scan["decision"]["event"]["id"] + "/notes"
        saved = await self.client.post(url, json={"note": "  Checked at gate  "})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual((await self.client.get(url)).json(), ["Checked at gate"])
        self.assertEqual((await self.client.post(url, json={"note": "  "})).status_code, 422)

    async def test_scheduled_rules_respect_disabled_state_and_persist_once(self):
        from workflows.activities import run_alert_rule_evaluation
        from models import AlertRule
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(AlertRule(id="rule-exit-balance", data={"id": "rule-exit-balance", "conditionKey": "exit_balance", "enabled": False}))
            db.add(Movement(id="unbalanced-exit", subject_id="p1", checkpoint_id="cp1", occurred_at=now,
                result="approved", direction="exit", scan_type="auto", subject_type="employee", sync_state="synced",
                data={"id": "unbalanced-exit", "subjectId": "p1", "subjectType": "employee"}))
            await db.commit()
        with patch("workflows.activities.async_session", self.sessions):
            self.assertEqual(await run_alert_rule_evaluation(), 0)
            async with self.sessions() as db:
                rule = await db.get(AlertRule, "rule-exit-balance")
                rule.data = {**rule.data, "enabled": True}
                await db.commit()
            outcomes = await asyncio.gather(run_alert_rule_evaluation(), run_alert_rule_evaluation())
            self.assertEqual(sum(outcomes), 1)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 1)

    async def test_workflow_notification_retry_does_not_duplicate(self):
        from workflows.activities import notify_admins_of_override
        async with self.sessions() as db:
            req_id = await self._create_review(db)
        with patch("workflows.activities.async_session", self.sessions):
            await asyncio.gather(notify_admins_of_override(req_id), notify_admins_of_override(req_id))
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Notification)), 1)

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
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="incomplete", checkpointId="cp1"), "test")
            self.assertFalse(result["allowed"])
            await db.commit()
            check = await repair_manual_entries(db)
            self.assertEqual(check["missingMetadata"], 0)
            self.assertEqual(check["missingPermissions"], 0)
