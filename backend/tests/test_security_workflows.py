"""Security authority, stale-decision, audit and egress regressions on isolated PostgreSQL."""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import test_database as fixture
from auth import verify_admin_request, verify_admin_or_operator_request, verify_terminal_access_request
from models import AccessPermission, Alert, AlertRule, AuditEvent, HardwareAsset, Movement, PermissionRequestModel, Person, PresenceState, Subject
from permission_decisions import apply_permission_decision, permission_version
from schemas import BrowserScanPayload
from sqlalchemy import func, select
from fastapi import HTTPException
from config import settings
from alert_rule_assignments import lock_scheduled_alert_evaluation
from terminal_scans import record_scan
from workflows.activities import approve_override, deny_override, approve_visitor, deny_visitor, auto_deny_override, auto_deny_visitor
from workflows.activities import run_alert_rule_evaluation


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class SecurityWorkflowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "verified-admin", "realm_access": {"roles": ["admin"]}}
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {
            "sub": "verified-admin", "realm_access": {"roles": ["admin"]}}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}

    async def request(self, **fields):
        self.authorize()
        response = await self.client.post("/v1/permission-requests", json={
            "subject_id": "p1", "checkpoint_id": "cp-main", "request_type": "zone_access",
            "reason": "Verified request", "requested_zones": ["public", "secure"], **fields})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def decide(self, request_id, decision="approved"):
        self.authorize()
        return await self.client.post(f"/v1/permission-requests/{request_id}/decide", json={
            "decision": decision, "reason": "Verified decision"})

    async def add_pending_visitor(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Subject(id="v1", kind="visitor", barcode="guest", person=Person(data={
                "name": "Guest", "status": "pending_approval", "allowedZones": [], "inside": False})))
            await db.flush()
            permission = AccessPermission(id="v1-permission", subject_id="v1", data={"state": "pending_approval", "zones": []})
            db.add(permission)
            db.add(PermissionRequestModel(id="visitor-request", subject_id="v1", created_at=now, data={
                "id": "visitor-request", "subjectId": "v1", "type": "visitor", "status": "pending",
                "permissionVersion": permission_version(permission), "requestedZones": ["public"],
                "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=1)).isoformat()}))
            await db.commit()

    async def test_forged_signal_activities_cannot_approve_or_deny_pending_requests(self):
        await self.add_pending_visitor()
        async with self.sessions() as db:
            db.add(PermissionRequestModel(id="manual-request", subject_id=None, created_at=datetime.now(timezone.utc), data={
                "id": "manual-request", "type": "manual_override", "status": "pending", "barcode": "unknown-forged"}))
            await db.commit()
        with patch("workflows.activities.async_session", self.sessions):
            results = [await approve_override("manual-request", "forged-admin", "Forged signal"),
                await deny_override("manual-request", "Forged signal"),
                await approve_visitor("visitor-request", "Forged signal"),
                await deny_visitor("visitor-request", "Forged signal"),
                await auto_deny_override("manual-request"), await auto_deny_visitor("visitor-request")]
        self.assertTrue(all(result["status"] == "pending" for result in results))
        async with self.sessions() as db:
            self.assertEqual((await db.get(AccessPermission, "v1-permission")).data["state"], "pending_approval")
            from models import EventOutbox
            self.assertEqual(await db.scalar(select(func.count()).select_from(EventOutbox)), 0)
            self.assertIsNone(await db.scalar(select(Subject).where(Subject.barcode == "unknown-forged")))
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)

    async def test_persisted_http_approval_is_authority_and_notification_preserves_actor(self):
        await self.add_pending_visitor()
        approved = await self.decide("visitor-request")
        self.assertEqual(approved.status_code, 200, approved.text)
        with patch("workflows.activities.async_session", self.sessions):
            observed = await approve_visitor("visitor-request", "Forged attribution")
            denied = await deny_visitor("visitor-request", "Forged opposite signal")
        self.assertEqual(observed, approved.json()["request"])
        self.assertEqual(denied, observed)
        self.assertEqual(observed["decidedBy"], "verified-admin")
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)
            self.assertEqual((await db.get(AccessPermission, "v1-permission")).data["state"], "active")

    async def test_timeout_uses_database_deadline_and_preserves_final_decision(self):
        await self.add_pending_visitor()
        with patch("workflows.activities.async_session", self.sessions):
            self.assertEqual((await auto_deny_visitor("visitor-request"))["status"], "pending")
            async with self.sessions() as db:
                req = await db.get(PermissionRequestModel, "visitor-request")
                req.created_at = datetime.now(timezone.utc) - timedelta(minutes=31)
                await db.commit()
            expired = await auto_deny_visitor("visitor-request")
            self.assertEqual(expired["status"], "denied")
            self.assertEqual(expired["decidedBy"], "system")
            self.assertEqual(await approve_visitor("visitor-request", "Late forged signal"), expired)

    async def test_busy_alert_evaluation_takes_no_subject_locks_and_http_returns_503(self):
        self.authorize()
        async with self.sessions() as blocker:
            await lock_scheduled_alert_evaluation(blocker)
            with patch("workflows.activities.async_session", self.sessions):
                response = await asyncio.wait_for(self.client.post("/v1/alerts/evaluate"), timeout=5)
            self.assertEqual(response.status_code, 503, response.text)
            self.assertEqual(response.json()["detail"]["code"], "alert_evaluation_busy")
            async with self.sessions() as probe:
                self.assertEqual(len((await probe.scalars(select(Subject.id).with_for_update(nowait=True))).all()), 2)
                await probe.rollback()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)

    async def test_alert_capacity_rejects_complete_work_before_locks_or_evaluation(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add(Subject(id="capacity-person", kind="employee", barcode="capacity-person",
                person=Person(data={"name": "Capacity person", "status": "active"})))
            db.add_all([Alert(id=f"capacity-alert-{i}", created_at=now, data={"id": f"capacity-alert-{i}"}) for i in range(2)])
            db.add_all([AlertRule(id=f"capacity-rule-{i}", data={"id": f"capacity-rule-{i}"}) for i in range(2)])
            await db.commit()
            payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
            self.assertTrue((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])
            await db.commit()
            # An immediate second attempt may be denied by anti-passback;
            # both outcomes must remain in the complete movement history.
            await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            await db.commit()
            expected_alerts = await db.scalar(select(func.count()).select_from(Alert))
            expected_movements = await db.scalar(select(func.count()).select_from(Movement))
        for setting, resource in (("ALERT_EVALUATION_MAX_SUBJECTS", "subjects"),
                ("ALERT_EVALUATION_MAX_MOVEMENTS", "movements"), ("ALERT_EVALUATION_MAX_ALERTS", "alerts"),
                ("ALERT_EVALUATION_MAX_RULES", "rules")):
            with self.subTest(resource=resource):
                async with self.sessions() as scan_lock:
                    await scan_lock.execute(select(Subject.id).where(Subject.id == "p1").with_for_update())
                    with patch.object(settings, setting, 1), patch("workflows.activities.async_session", self.sessions), \
                         patch("rule_engine.evaluate_scheduled_rules") as evaluate:
                        with self.assertRaises(HTTPException) as error:
                            await asyncio.wait_for(run_alert_rule_evaluation(), timeout=5)
                        self.assertEqual(error.exception.status_code, 503)
                        self.assertEqual(error.exception.detail["code"], "alert_evaluation_capacity_exceeded")
                        self.assertEqual(error.exception.detail["resource"], resource)
                        evaluate.assert_not_called()
                    # Capacity failure occurs before trying to lock p1. Other
                    # scan subjects remain independently available.
                    async with self.sessions() as probe:
                        self.assertEqual(await probe.scalar(select(Subject.id).where(Subject.id == "h1")
                            .with_for_update(nowait=True)), "h1")
                async with self.sessions() as db:
                    self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), expected_alerts)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), expected_movements)

    async def test_active_scan_causes_alert_evaluation_to_reject_and_release_other_subjects(self):
        async with self.sessions() as scan_lock:
            await scan_lock.execute(select(Subject.id).where(Subject.id == "p1").with_for_update())
            # Only an actual alert candidate needs a subject lock now.
            with patch("workflows.activities.async_session", self.sessions), \
                 patch("workflows.activities.datetime", wraps=datetime) as clock:
                clock.now.return_value = datetime(2026, 10, 10, 13, tzinfo=timezone.utc)
                with self.assertRaises(HTTPException) as error:
                    await asyncio.wait_for(run_alert_rule_evaluation(), timeout=5)
            self.assertEqual(error.exception.status_code, 503)
            self.assertEqual(error.exception.detail["code"], "alert_evaluation_busy")
            async with self.sessions() as probe:
                self.assertEqual(await probe.scalar(select(Subject.id).where(Subject.id == "h1")
                    .with_for_update(nowait=True)), "h1")

    async def test_stale_zone_approval_conflicts_and_current_request_succeeds(self):
        request = await self.request()
        async with self.sessions() as db:
            db.add(AccessPermission(id="p1-permission", subject_id="p1", data={"state": "revoked", "zones": []}))
            await db.commit()
        stale = await self.decide(request["id"])
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "permission_changed")
        self.assertEqual(stale.json()["detail"]["currentPermission"]["state"], "revoked")
        async with self.sessions() as db:
            self.assertEqual((await db.get(PermissionRequestModel, request["id"])).data["status"], "pending")
            self.assertEqual((await db.get(AccessPermission, "p1-permission")).data["state"], "revoked")
        current = await self.request()
        approved = await self.decide(current["id"])
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["permission"]["zones"], ["public", "secure"])

    async def test_stale_custody_approval_conflicts_without_overwriting_newer_transfer(self):
        async with self.sessions() as db:
            db.add_all([Subject(id=subject_id, barcode=subject_id, kind="employee", person=Person(data={"name": name}))
                for subject_id, name in (("p2", "Bob"), ("p3", "Carol"))])
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "p1"}
            await db.commit()
        request = await self.request(subject_id="h1", request_type="hardware_custody", carrier_id="p2")
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "p3"}
            await db.commit()
        stale = await self.decide(request["id"])
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "custody_changed")
        self.assertEqual(stale.json()["detail"]["currentCarrierId"], "p3")
        async with self.sessions() as db:
            self.assertEqual((await db.get(HardwareAsset, "h1")).data["assignedEmployeeId"], "p3")
        self.assertEqual((await self.decide(request["id"], "denied")).status_code, 200)
        current = await self.request(subject_id="h1", request_type="hardware_custody", carrier_id="p2")
        self.assertEqual((await self.decide(current["id"])).status_code, 200)

    async def test_replay_is_an_explicit_receipt_and_never_authorizes_another_movement(self):
        key = uuid.uuid4()
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
        async with self.sessions() as db:
            fresh = await record_scan(db, key, payload, "browser:operator")
            await db.commit()
            self.assertFalse(fresh["replayed"])
            self.assertTrue(fresh["authorizeMovement"])
            replay = await record_scan(db, key, payload, "browser:operator")
            self.assertTrue(replay["replayed"])
            self.assertFalse(replay["authorizeMovement"])
            self.assertTrue(replay["decision"]["replayed"])
            self.assertFalse(replay["decision"]["authorizeMovement"])
            self.assertEqual(fresh["decision"]["event"], replay["decision"]["event"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)

    async def test_manual_capture_cannot_forge_reviewed_admission_classification(self):
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(
                barcode="p1", checkpointId="cp-main", scanType="manual"), "browser:operator")
            self.assertTrue(result["allowed"])
            event = result["decision"]["event"]
            self.assertEqual(event["captureMethod"], "manual")
            self.assertEqual(event["scanType"], "auto")
            self.assertEqual(event["operatorIdentity"], "browser:operator")
            self.assertNotIn("adminId", event)
            self.assertEqual((await db.get(Movement, event["id"])).scan_type, "auto")

    async def test_expired_inactive_matching_exit_succeeds_and_reentry_is_denied(self):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main")
        async with self.sessions() as db:
            self.assertTrue((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])
            await db.commit()
            state = await db.get(PresenceState, "p1")
            state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "inactive", "allowedZones": [],
                "validTo": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
            await db.commit()
            exit_result = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(exit_result["allowed"], exit_result)
            self.assertEqual(exit_result["reason"], "Exit for existing admitted entry")
            await db.commit()
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
            self.assertFalse((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])

    async def test_matching_exit_still_rejects_wrong_custody_or_new_hardware(self):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"])
        async with self.sessions() as db:
            self.assertTrue((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])
            await db.commit()
            state = await db.get(PresenceState, "p1")
            state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "inactive", "validTo": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "different-person"}
            await db.commit()
            rejected = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(rejected["allowed"])
            self.assertEqual(rejected["decision"]["event"]["denialCode"], "custody_mismatch")
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")

    async def test_manual_visit_custody_snapshot_cannot_authorize_a_later_transfer(self):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"])
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "reviewed-owner"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(denied["allowed"])
            await db.commit()
            request_id = await fixture.DatabaseTests._create_review(self, db, "p1", "p1", denied["decision"]["event"])
            await apply_permission_decision(db, request_id, "approved", "verified-admin", "Reviewed asset custody")
            await db.commit()
            admitted = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(admitted["allowed"], admitted)
            await db.commit()
            snapshot = (await db.get(PresenceState, "p1")).entry_override["hardwareCustody"]["h1"]
            self.assertEqual(snapshot["assignedEmployeeId"], "reviewed-owner")
            asset.data = {**asset.data, "assignedEmployeeId": "later-owner"}
            await db.commit()
            rejected = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(rejected["allowed"], rejected)
            self.assertEqual(rejected["decision"]["event"]["denialCode"], "custody_mismatch")
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")
            self.assertEqual((await db.get(PresenceState, "h1")).state, "inside")

    async def test_manual_grant_rejects_custody_change_between_approval_and_consumption(self):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"])
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "reviewed-owner"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(denied["allowed"])
            await db.commit()
            request_id = await fixture.DatabaseTests._create_review(self, db, "p1", "p1", denied["decision"]["event"])
            approved = await apply_permission_decision(db, request_id, "approved", "verified-admin", "Reviewed custody")
            self.assertEqual(approved["request"]["hardwareCustody"]["h1"]["assignedEmployeeId"], "reviewed-owner")
            await db.commit()
            asset.data = {**asset.data, "assignedEmployeeId": "new-owner"}
            await db.commit()
            rejected = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(rejected["allowed"], rejected)
            request = await db.get(PermissionRequestModel, request_id)
            self.assertNotIn("consumedAt", request.data)
            self.assertEqual(request.data["hardwareCustody"]["h1"]["assignedEmployeeId"], "reviewed-owner")
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
            self.assertEqual((await db.get(PresenceState, "h1")).state, "outside")

    async def test_direct_reviewed_assigned_hardware_exits_once_without_fresh_bypass(self):
        payload = BrowserScanPayload(barcode="h1", checkpointId="cp-main")
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "p1"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertFalse(denied["allowed"])
            await db.commit()
            request_id = await fixture.DatabaseTests._create_review(self, db, "h1", "h1", denied["decision"]["event"])
            await apply_permission_decision(db, request_id, "approved", "verified-admin", "Reviewed direct asset visit")
            await db.commit()
            admitted = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(admitted["allowed"], admitted)
            await db.commit()
            exit_result = await record_scan(db, uuid.uuid4(), payload, "browser:operator")
            self.assertTrue(exit_result["allowed"], exit_result)
            self.assertEqual(exit_result["reason"], "Exit for manually approved entry")
            await db.commit()
            self.assertEqual((await db.get(PresenceState, "h1")).state, "outside")
            self.assertIsNone((await db.get(PresenceState, "h1")).entry_override)
            self.assertFalse((await record_scan(db, uuid.uuid4(), payload, "browser:operator"))["allowed"])
