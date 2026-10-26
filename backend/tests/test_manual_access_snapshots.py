"""Unused manual grants follow subsequent administrator access changes."""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import test_database as fixture
from auth import verify_admin_request
from manual_review_policy import revised_access_data
from models import AccessPermission, HardwareAsset, PermissionRequestModel, Person, PresenceState, Subject
from permission_decisions import apply_permission_decision
from schemas import BrowserScanPayload
from sqlalchemy import select, text
from terminal_scans import record_scan


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class ManualAccessSnapshotTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def approve(self, *, hardware=False, with_permission=True, active_person=False):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main",
            selectedHardwareIds=["h1"] if hardware else [])
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            now = datetime.now(timezone.utc)
            window = {"validFrom": now.isoformat(), "validTo": (now + timedelta(hours=1)).isoformat()} if active_person else {}
            person.data = {**person.data, "status": "active" if active_person else "restricted", **window}
            if active_person:
                person.data["allowedZones"] = ["public"]
            if with_permission:
                db.add(AccessPermission(id="p1-access", subject_id="p1", data={
                    "state": "active" if active_person else "restricted", "zones": ["public"],
                    "validFrom": "", "validTo": "", **window}))
                if hardware:
                    db.add(AccessPermission(id="h1-access", subject_id="h1", data={
                        "state": "active", "zones": ["public"], "validFrom": "", "validTo": ""}))
            if hardware:
                asset = await db.get(HardwareAsset, "h1")
                asset.data = {**asset.data, "ownerId": "p1", "assignedEmployeeId": "reviewed-other-owner" if active_person else "p1",
                              "owner": "Alice", "assignedEmployeeName": "Alice"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(denied["allowed"], denied)
            await db.commit()
            request_id = await fixture.DatabaseTests._create_review(self, db,
                "p1", "p1", denied["decision"]["event"])
            result = await apply_permission_decision(db, request_id, "approved", "admin", "Reviewed original denial")
            await db.commit()
            expected = {"p1", "h1"} if hardware else {"p1"}
            self.assertEqual(set(result["request"]["accessSnapshots"]), expected)
            return payload, request_id, dict(result["request"]["accessSnapshots"])

    async def update(self, subject_id, data):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        response = await self.client.put(f"/v1/registry/subjects/{subject_id}", json={"data": data})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    async def assert_unused_denied(self, payload, request_id):
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(result["allowed"], result)
            self.assertNotIn("manualApprovalRequestId", result["decision"]["event"])
            await db.commit()
            self.assertNotIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)
            for subject_id in ["p1", *payload.selected_hardware_ids]:
                self.assertEqual((await db.get(PresenceState, subject_id)).state, "outside")

    async def test_employee_revocation_invalidates_unused_manual_approval(self):
        payload, request_id, _ = await self.approve()
        await self.update("p1", {"status": "inactive"})
        await self.assert_unused_denied(payload, request_id)

    async def test_carried_hardware_maintenance_invalidates_unused_manual_approval(self):
        payload, request_id, _ = await self.approve(hardware=True)
        await self.update("h1", {"status": "maintenance"})
        await self.assert_unused_denied(payload, request_id)

    async def test_every_reviewed_subject_zone_and_window_change_invalidates_approval(self):
        payload, request_id, snapshots = await self.approve(hardware=True)
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            for subject_id, patch_data in (("p1", {"zones": ["secure"]}),
                                          ("h1", {"validFrom": now.isoformat(),
                                                   "validTo": (now + timedelta(hours=2)).isoformat()})):
                with self.subTest(subject_id=subject_id):
                    permission = await db.get(AccessPermission, subject_id + "-access")
                    original = dict(permission.data)
                    permission.data = revised_access_data(original, {**original, **patch_data}, permission=True)
                    await db.commit()
                    await self.assert_unused_denied(payload, request_id)
                    # Reset this isolated mutation so the other reviewed
                    # subject is independently responsible for rejection.
                    permission.data = original
                    await db.commit()
            request = await db.get(PermissionRequestModel, request_id)
            self.assertEqual(request.data["accessSnapshots"], snapshots)

    async def test_change_then_revert_is_detected_for_legacy_subject_without_permission(self):
        payload, request_id, snapshots = await self.approve(with_permission=False)
        first = await self.update("p1", {"status": "inactive"})
        restored = await self.update("p1", {"status": "restricted", "accessRevision": None})
        self.assertNotEqual(first["accessRevision"], restored["accessRevision"])
        self.assertEqual(snapshots["p1"]["permission"], None)
        self.assertEqual(restored["status"], snapshots["p1"]["metadata"]["status"])
        await self.assert_unused_denied(payload, request_id)

    async def test_same_access_regrant_invalidates_older_manual_approval(self):
        payload, request_id, snapshots = await self.approve(hardware=True, active_person=True)
        reviewed = snapshots["p1"]["permission"]
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        granted = await self.client.post("/v1/permissions/grant", json={
            "subject_id": "p1", "checkpoint_id": "cp-main", "request_type": "zone_access",
            "reason": "Replacement access", "requested_zones": ["public"],
            "valid_from": reviewed["validFrom"], "valid_to": reviewed["validTo"]})
        self.assertEqual(granted.status_code, 201, granted.text)
        for field in ("state", "zones", "validFrom", "validTo"):
            self.assertEqual(granted.json()["permission"][field], reviewed[field])
        self.assertNotEqual(granted.json()["permission"].get("accessRevision"), reviewed["accessRevision"])
        await self.assert_unused_denied(payload, request_id)

    async def test_unchanged_access_and_cosmetic_edits_preserve_original_denial_override(self):
        payload, request_id, snapshots = await self.approve(hardware=True)
        await self.update("p1", {"name": "Corrected employee", "accessRevision": "forged"})
        await self.update("h1", {"name": "Renamed laptop", "category": "Desktop"})
        async with self.sessions() as db:
            denied = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(denied["allowed"], denied)
            self.assertEqual(denied["decision"]["event"]["manualApprovalRequestId"], request_id)
            self.assertEqual(denied["decision"]["event"]["initialResult"], "denied")
            await db.commit()
            req = await db.get(PermissionRequestModel, request_id)
            self.assertEqual(req.data["accessSnapshots"], snapshots)
            self.assertIn("consumedAt", req.data)
            self.assertNotEqual((await db.get(Person, "p1")).data.get("accessRevision"), "forged")

    async def test_custody_transfer_and_revert_invalidates_unused_approval(self):
        payload, request_id, _ = await self.approve(hardware=True)
        async with self.sessions() as db:
            db.add(Subject(id="p2", barcode="p2", kind="employee", person=Person(data={"name": "Bob"})))
            await db.commit()
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        revisions = []
        for carrier_id in ("p2", "p1"):
            transferred = await self.client.post("/v1/permissions/grant", json={
                "subject_id": "h1", "checkpoint_id": "cp-main", "request_type": "hardware_custody",
                "carrier_id": carrier_id, "reason": "Reviewed custody transfer"})
            self.assertEqual(transferred.status_code, 201, transferred.text)
            revisions.append(transferred.json()["hardwareAsset"]["accessRevision"])
        self.assertNotEqual(revisions[0], revisions[1])
        await self.assert_unused_denied(payload, request_id)

    async def test_legacy_manual_grant_without_snapshot_cannot_override_denial(self):
        payload, request_id, _ = await self.approve()
        async with self.sessions() as db:
            request = await db.get(PermissionRequestModel, request_id)
            request.data = {key: value for key, value in request.data.items() if key != "accessSnapshots"}
            await db.commit()
        await self.assert_unused_denied(payload, request_id)

    async def test_consumed_entry_keeps_safe_exit_after_employee_revocation(self):
        payload, request_id, _ = await self.approve()
        async with self.sessions() as db:
            entered = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(entered["allowed"], entered)
            await db.commit()
        await self.update("p1", {"status": "inactive", "allowedZones": ["secure"]})
        async with self.sessions() as db:
            exited = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(exited["allowed"], exited)
            self.assertEqual(exited["decision"]["event"]["direction"], "exit")
            self.assertEqual(exited["reason"], "Exit for manually approved entry")
            await db.commit()
            self.assertIsNone((await db.get(PresenceState, "p1")).entry_override)
            self.assertIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)
            self.assertFalse((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])

    async def test_scan_waiting_for_revocation_lock_refreshes_and_rejects_unused_grant(self):
        payload, request_id, _ = await self.approve()
        async with self.sessions() as updater, self.sessions() as scanner:
            subject = await updater.scalar(select(Subject).where(Subject.id == "p1").with_for_update())
            person = await updater.get(Person, subject.id)
            person.data = revised_access_data(person.data, {**person.data, "status": "inactive"})
            permission = await updater.get(AccessPermission, "p1-access")
            permission.data = revised_access_data(permission.data, {**permission.data, "state": "revoked"}, permission=True)
            await updater.flush()
            # A stale permission already in the scanning session must not
            # survive the wait for the administrator's subject lock.
            await scanner.get(AccessPermission, "p1-access")
            pid = await scanner.scalar(text("SELECT pg_backend_pid()"))
            task = asyncio.create_task(record_scan(scanner, uuid.uuid4(), payload, "browser:operator"))
            try:
                waiting = False
                for _ in range(100):
                    async with self.engine.connect() as observer:
                        waiting = await observer.scalar(text("SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=:pid"), {"pid": pid})
                    if waiting:
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(waiting, "The scan must wait for the administrator's subject lock")
                await updater.commit()
                result = await asyncio.wait_for(task, 5)
                self.assertFalse(result["allowed"], result)
                await scanner.commit()
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        async with self.sessions() as db:
            self.assertNotIn("consumedAt", (await db.get(PermissionRequestModel, request_id)).data)
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
