"""Regression coverage for visitor grant, custody, and scan transaction edges."""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, Mock, patch

import test_database as fixture
from auth import verify_admin_or_operator_request, verify_admin_request
from fastapi import HTTPException
from models import AccessPermission, AuditEvent, HardwareAsset, Movement, PermissionRequestModel, Person, PresenceState, ScanRequest, Subject
from permission_decisions import apply_permission_decision
from schemas import BrowserScanPayload
from sqlalchemy import func, select, text
from terminal_scans import record_scan


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class WorkflowEdgeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {
            "sub": "operator", "realm_access": {"roles": ["operator"]}}

    async def add_visitor(self, *, active=False):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Subject(id="v1", kind="visitor", barcode="visitor", person=Person(data={
                "name": "Guest", "status": "pre_approved" if active else "pending_approval",
                "inside": False, "allowedZones": ["public"] if active else [],
                "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=4)).isoformat()})))
            await db.flush()
            permission = AccessPermission(id="visitor-permission", subject_id="v1", data={
                "state": "active" if active else "pending_approval", "zones": ["public"] if active else [],
                "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=4)).isoformat(),
                "updatedAt": now.isoformat(), "updatedBy": "admin"})
            db.add(permission)
            await db.commit()
            return dict(permission.data)

    async def request(self, **fields):
        self.authorize()
        temporal = Mock(start_workflow=AsyncMock())
        with patch("routers.permissions.get_temporal_client", new=AsyncMock(return_value=temporal)), \
             patch("routers.permissions.publish_decision", new=AsyncMock()):
            return await self.client.post("/v1/permission-requests", json={
                "subject_id": "v1", "checkpoint_id": "cp-main", "request_type": "visitor",
                "reason": "Visit", **fields})

    async def test_manual_denial_preserves_existing_visit_and_carried_hardware(self):
        now = datetime.now(timezone.utc)
        started_at = now - timedelta(hours=13)
        snapshots = {}
        async with self.sessions() as db:
            for subject_id, model in (("p1", Person), ("h1", HardwareAsset)):
                metadata = await db.get(model, subject_id)
                metadata.data = {**metadata.data, "inside": True,
                    **({"status": "maintenance"} if subject_id == "h1" else {})}
                snapshots[subject_id] = dict(metadata.data)
                db.add(PresenceState(subject_id=subject_id, state="inside", entry_building_id="main-building",
                    last_scan_timestamp=now - timedelta(minutes=2), entry_started_at=started_at,
                    entry_override={"requestId": "existing-entry", "hardwareIds": ["h1"]}))
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(
                barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"]), "browser:operator")
            self.assertFalse(denied["allowed"])
            source = denied["decision"]["event"]
            self.assertEqual(source["direction"], "exit")
            req = PermissionRequestModel(id="review-existing-visit", subject_id="p1", created_at=now, data={
                "id": "review-existing-visit", "type": "manual_override", "status": "pending",
                "eventId": source["id"], "barcode": "p1", "checkpointId": "cp-main", "direction": "exit"})
            db.add(req)
            await db.commit()

        async with self.sessions() as db:
            result = await apply_permission_decision(db, req.id, "denied", "admin", "Asset remains unsafe")
            await db.commit()
            self.assertEqual(result["movement"]["id"], source["id"])
            self.assertEqual((result["movement"]["direction"], result["movement"]["denialCode"]),
                             ("exit", "manual_review"))
            retry = await apply_permission_decision(db, req.id, "denied", "admin", "Repeated decision")
            await db.commit()
            self.assertEqual(retry["movement"], result["movement"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)
            for subject_id, model in (("p1", Person), ("h1", HardwareAsset)):
                self.assertEqual((await db.get(model, subject_id)).data, snapshots[subject_id])
                state = await db.get(PresenceState, subject_id)
                self.assertEqual((state.state, state.entry_building_id, state.entry_started_at,
                                  state.last_scan_timestamp, state.entry_override),
                                 ("inside", "main-building", started_at, now - timedelta(minutes=2),
                                  {"requestId": "existing-entry", "hardwareIds": ["h1"]}))

    async def test_legacy_manual_denial_without_scan_retains_one_historical_movement(self):
        now = datetime.now(timezone.utc)
        request_id = "legacy-denial"
        async with self.sessions() as db:
            db.add(PermissionRequestModel(id=request_id, created_at=now, data={
                "id": request_id, "type": "manual_override", "status": "pending",
                "barcode": "legacy-unknown", "checkpointId": "main-gate", "direction": "entry"}))
            await db.commit()
            result = await apply_permission_decision(db, request_id, "denied", "admin", "Unverified identity")
            await db.commit()
            movement = result["movement"]
            self.assertTrue(movement["id"].startswith("MAN-"))
            self.assertEqual((movement["result"], movement["denialCode"], movement["checkpointId"]),
                             ("denied", "manual_review", "cp-main"))
            retry = await apply_permission_decision(db, request_id, "denied", "admin", "Retried")
            await db.commit()
            self.assertEqual(retry["movement"], movement)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(PresenceState)), 0)
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "legacy-unknown")))

    async def test_operator_cannot_create_request_that_revokes_active_visitor(self):
        original = await self.add_visitor(active=True)
        response = await self.request()
        self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(PermissionRequestModel)), 0)
            self.assertEqual((await db.get(AccessPermission, "visitor-permission")).data, original)
            self.assertEqual((await db.get(Person, "v1")).data["status"], "pre_approved")

    async def test_duplicate_pending_visitor_request_reuses_original_version(self):
        await self.add_visitor()
        first, second = await self.request(), await self.request()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.json(), first.json())
        self.assertTrue(first.json()["permissionVersion"])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(PermissionRequestModel)), 1)
            result = await apply_permission_decision(db, first.json()["id"], "approved", "admin", "Checked")
            await db.commit()
            self.assertEqual(result["permission"]["state"], "active")
            self.assertEqual(result["request"]["status"], "approved")

    async def test_stale_visitor_decisions_preserve_newer_permission_and_metadata(self):
        await self.add_visitor()
        created = await self.request()
        self.assertEqual(created.status_code, 200, created.text)
        request_id = created.json()["id"]
        async with self.sessions() as db:
            permission = await db.get(AccessPermission, "visitor-permission")
            newer = {**permission.data, "state": "active", "zones": ["secure"],
                "updatedAt": datetime.now(timezone.utc).isoformat(), "updatedBy": "new-admin"}
            permission.data = newer
            person = await db.get(Person, "v1")
            metadata = {**person.data, "status": "pre_approved", "allowedZones": ["secure"]}
            person.data = metadata
            await db.commit()
        for decision in ("approved", "denied"):
            with self.subTest(decision=decision):
                async with self.sessions() as db:
                    req = await db.get(PermissionRequestModel, request_id)
                    req.data = {key: value for key, value in created.json().items()}
                    await db.commit()
                    result = await apply_permission_decision(db, request_id, decision, "system" if decision == "denied" else "admin",
                        "Old decision")
                    await db.commit()
                    self.assertEqual(result["request"]["status"], "denied")
                    self.assertIn("supersededAt", result["request"])
                    self.assertEqual((await db.get(AccessPermission, "visitor-permission")).data, newer)
                    self.assertEqual((await db.get(Person, "v1")).data, metadata)

    async def test_newer_zone_approval_survives_older_visitor_timeout(self):
        await self.add_visitor()
        visitor = await self.request()
        zone = await self.request(request_type="zone_access", requested_zones=["secure"])
        self.assertEqual(visitor.status_code, 200, visitor.text)
        self.assertEqual(zone.status_code, 200, zone.text)
        async with self.sessions() as db:
            approved = await apply_permission_decision(db, zone.json()["id"], "approved", "admin", "Secure zone grant")
            await db.commit()
            granted = dict((await db.get(AccessPermission, "visitor-permission")).data)
            visitor_request = await db.get(PermissionRequestModel, visitor.json()["id"])
            visitor_request.created_at = datetime.now(timezone.utc) - timedelta(minutes=31)
            await db.commit()
            timed_out = await apply_permission_decision(db, visitor.json()["id"], "denied", "system", "No response", from_activity=True, expire_only=True)
            await db.commit()
            self.assertEqual(approved["request"]["status"], "approved")
            self.assertEqual(timed_out["request"]["status"], "denied")
            self.assertEqual((await db.get(AccessPermission, "visitor-permission")).data, granted)
            self.assertEqual((await db.get(Person, "v1")).data["allowedZones"], ["secure"])

    async def test_legacy_visitor_timeout_cannot_revoke_existing_grant(self):
        original = await self.add_visitor(active=True)
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(PermissionRequestModel(id="legacy", subject_id="v1", created_at=now - timedelta(minutes=31), data={
                "id": "legacy", "subjectId": "v1", "type": "visitor", "status": "pending",
                "requestedZones": ["public"], "validFrom": now.isoformat(),
                "validTo": (now + timedelta(hours=1)).isoformat()}))
            await db.commit()
            result = await apply_permission_decision(db, "legacy", "denied", "system", "Timed out", from_activity=True, expire_only=True)
            await db.commit()
            self.assertEqual(result["request"]["status"], "denied")
            self.assertEqual((await db.get(AccessPermission, "visitor-permission")).data, original)

    async def test_legacy_pending_registration_remains_approvable(self):
        await self.add_visitor()
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(PermissionRequestModel(id="legacy", subject_id="v1", created_at=now - timedelta(minutes=1), data={
                "id": "legacy", "subjectId": "v1", "type": "visitor", "status": "pending",
                "requestedZones": ["public"], "validFrom": now.isoformat(),
                "validTo": (now + timedelta(hours=1)).isoformat()}))
            await db.commit()
            result = await apply_permission_decision(db, "legacy", "approved", "admin", "Checked")
            await db.commit()
            self.assertEqual(result["request"]["status"], "approved")
            self.assertEqual(result["permission"]["state"], "active")

    async def test_expired_visitor_can_request_and_receive_renewal(self):
        await self.add_visitor(active=True)
        async with self.sessions() as db:
            permission = await db.get(AccessPermission, "visitor-permission")
            permission.data = {**permission.data, "validTo": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
            await db.commit()
        created = await self.request()
        self.assertEqual(created.status_code, 200, created.text)
        async with self.sessions() as db:
            result = await apply_permission_decision(db, created.json()["id"], "approved", "admin", "Renewed")
            await db.commit()
            self.assertEqual(result["request"]["status"], "approved")
            self.assertEqual(result["permission"]["state"], "active")

    async def test_descriptive_visitor_edit_does_not_supersede_pending_approval(self):
        await self.add_visitor()
        created = await self.request()
        self.assertEqual(created.status_code, 200, created.text)
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            updated = await self.client.put("/v1/registry/subjects/v1", json={"data": {"name": "Corrected guest"}})
        self.assertEqual(updated.status_code, 200, updated.text)
        async with self.sessions() as db:
            result = await apply_permission_decision(db, created.json()["id"], "approved", "admin", "Checked")
            await db.commit()
            self.assertEqual(result["request"]["status"], "approved")
            self.assertEqual((await db.get(Person, "v1")).data["name"], "Corrected guest")

    async def set_hardware_owner(self):
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "ownerId": "p1", "owner": "Alice",
                "assignedEmployeeId": "p1", "assignedEmployeeName": "Alice"}
            await db.commit()
            return dict(asset.data)

    async def test_registry_rejects_blank_missing_and_non_employee_owner_or_custodian(self):
        self.authorize()
        original = await self.set_hardware_owner()
        await self.add_visitor()
        for field in ("ownerId", "assignedEmployeeId"):
            for value in ("", "   ", None, 42, "missing", "v1", "h1"):
                with self.subTest(field=field, value=value):
                    response = await self.client.put("/v1/registry/subjects/h1", json={
                        "barcode": "forged-replacement", "data": {field: value}})
                    self.assertEqual(response.status_code, 422, response.text)
                    async with self.sessions() as db:
                        self.assertEqual((await db.get(HardwareAsset, "h1")).data, original)
                        self.assertEqual((await db.get(Subject, "h1")).barcode, "h1")

    async def test_registry_canonicalizes_employee_names_and_retains_distinct_custody(self):
        self.authorize()
        await self.set_hardware_owner()
        async with self.sessions() as db:
            db.add(Subject(id="p2", kind="employee", barcode="p2", person=Person(data={"name": "Bob", "status": "active"})))
            await db.commit()
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            updated = await self.client.put("/v1/registry/subjects/h1", json={"data": {
                "ownerId": " p2 ", "owner": "Forged owner", "assignedEmployeeId": " p1 ",
                "assignedEmployeeName": "Forged custodian"}})
        self.assertEqual(updated.status_code, 200, updated.text)
        data = updated.json()["data"]
        self.assertEqual((data["ownerId"], data["owner"]), ("p2", "Bob"))
        self.assertEqual((data["assignedEmployeeId"], data["assignedEmployeeName"]), ("p1", "Alice"))
        async with self.sessions() as db:
            scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp-main"), "browser:operator")
            self.assertFalse(scan["allowed"], scan)
            self.assertEqual(scan["decision"]["event"]["denialCode"], "custody_mismatch")

    async def test_duplicate_barcode_update_returns_conflict_without_persisting_metadata(self):
        self.authorize()
        async with self.sessions() as db:
            db.add(AccessPermission(id="employee-permission", subject_id="p1", data={
                "state": "active", "zones": ["public"], "subjectName": "Alice"}))
            await db.commit()
        for subject_id, barcode, patch_data in (("p1", "H1", {"name": "Changed employee"}),
                                                ("h1", "P1", {"ownerId": "p1", "name": "Changed asset"})):
            with self.subTest(subject_id=subject_id):
                with patch("routers.registry.publish_data_changed", new=AsyncMock()) as publish:
                    response = await self.client.put(f"/v1/registry/subjects/{subject_id}", json={
                        "barcode": barcode, "data": patch_data})
                self.assertEqual(response.status_code, 409, response.text)
                publish.assert_not_awaited()
                async with self.sessions() as db:
                    self.assertEqual((await db.get(Subject, subject_id)).barcode, subject_id)
                    metadata = await db.get(Person if subject_id == "p1" else HardwareAsset, subject_id)
                    self.assertEqual(metadata.data["name"], "Alice" if subject_id == "p1" else "Laptop")
                    self.assertEqual((await db.get(AccessPermission, "employee-permission")).data,
                        {"state": "active", "zones": ["public"], "subjectName": "Alice"})

    async def test_scan_rejects_barcode_replaced_while_waiting_for_subject_lock(self):
        async with self.sessions() as updater, self.sessions() as scanner:
            subject = await updater.scalar(select(Subject).where(Subject.id == "p1").with_for_update())
            subject.barcode = "replacement-barcode"
            await updater.flush()
            pid = await scanner.scalar(text("SELECT pg_backend_pid()"))
            task = asyncio.create_task(record_scan(scanner, uuid.uuid4(),
                BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator"))
            try:
                waiting = False
                for _ in range(100):
                    async with self.engine.connect() as observer:
                        waiting = await observer.scalar(text("SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid=:pid"), {"pid": pid})
                    if waiting:
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(waiting, "The scan must wait for the registry subject lock")
                await updater.commit()
                with self.assertRaises(HTTPException) as error:
                    await asyncio.wait_for(task, 5)
                self.assertEqual(error.exception.status_code, 409)
                await scanner.rollback()
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        async with self.sessions() as db:
            self.assertEqual((await db.get(Subject, "p1")).barcode, "replacement-barcode")
            self.assertIsNone(await db.get(PresenceState, "p1"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ScanRequest)), 0)
            replacement = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="replacement-barcode", checkpointId="cp-main"), "browser:operator")
            self.assertTrue(replacement["allowed"], replacement)

    async def manual_request(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            await db.commit()
            denial = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertFalse(denial["allowed"])
            await db.commit()
        created = await self.request(subject_id="p1", request_type="manual_override",
            event_id=denial["decision"]["event"]["id"], direction="entry", operator_note="Check ID")
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()["id"]

    async def complete_newer_visit(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "active"}
            await db.commit()
            entered = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertTrue(entered["allowed"], entered)
            await db.commit()
            state = await db.get(PresenceState, "p1")
            state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            await db.commit()
            exited = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertTrue(exited["allowed"], exited)
            self.assertEqual(exited["decision"]["event"]["direction"], "exit")
            await db.commit()
            person.data = {**person.data, "status": "restricted"}
            await db.commit()

    async def test_manual_approval_rejects_denial_superseded_by_completed_visit(self):
        request_id = await self.manual_request()
        await self.complete_newer_visit()
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await apply_permission_decision(db, request_id, "approved", "admin", "Late review")
            self.assertEqual(error.exception.status_code, 409)
            await db.rollback()
            self.assertEqual((await db.get(PermissionRequestModel, request_id)).data["status"], "pending")

    async def test_manual_grant_for_old_denial_cannot_authorize_another_visit(self):
        request_id = await self.manual_request()
        async with self.sessions() as db:
            await apply_permission_decision(db, request_id, "approved", "admin", "Checked")
            await db.commit()
            req = await db.get(PermissionRequestModel, request_id)
            # Preserve an unused grant while a different administrator's access
            # admits and completes a newer visit.
            req.data = {**req.data, "validFrom": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()}
            await db.commit()
        await self.complete_newer_visit()
        async with self.sessions() as db:
            req = await db.get(PermissionRequestModel, request_id)
            req.data = {**req.data, "validFrom": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
            await db.commit()
            scanned = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertFalse(scanned["allowed"], scanned)
            await db.commit()
            self.assertNotIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)

    async def test_repeated_denials_do_not_invalidate_manual_approval(self):
        request_id = await self.manual_request()
        async with self.sessions() as db:
            denial = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertFalse(denial["allowed"])
            await db.commit()
            approved = await apply_permission_decision(db, request_id, "approved", "admin", "Checked")
            self.assertEqual(approved["request"]["status"], "approved")
            await db.commit()
            admitted = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "browser:operator")
            self.assertTrue(admitted["allowed"], admitted)
            self.assertEqual(admitted["decision"]["event"]["manualApprovalRequestId"], request_id)
