"""Typed request effects and validation, without external services."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from pydantic import ValidationError
from models import Subject, Person, HardwareAsset, PermissionRequestModel, AccessPermission, Checkpoint, TerminalCheckpointAssignment
from schemas import PermissionRequestCreate, ManualReviewPayload, PermissionDecision
from routers.permissions import create_permission_request
from routers.terminal import create_manual_review
from permission_decisions import apply_permission_decision, decision_event, zone_permission_version, custody_version


def scalar_result(value):
    result = Mock()
    result.scalar_one_or_none.return_value = value
    return result


def session():
    db = Mock()
    db.execute = AsyncMock()
    db.scalar = AsyncMock(return_value=None)
    rows = Mock()
    rows.all.return_value = []
    db.scalars = AsyncMock(return_value=rows)
    db.get = AsyncMock(return_value=None)
    db.commit = AsyncMock()
    db.flush = AsyncMock()
    return db


class TypedPermissionRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for target in ("routers.permissions.enqueue_decision", "routers.permissions.enqueue_workflow_start",
                "routers.terminal.enqueue_presence", "routers.terminal.enqueue_workflow_start"):
            item = patch(target, new=AsyncMock(return_value=1))
            item.start()
            self.addCleanup(item.stop)

    def test_http_duration_choices_reject_coercion_and_non_menu_values(self):
        for duration in (15, 30, 60, 120, 240):
            self.assertEqual(PermissionDecision(decision="approved", valid_for_minutes=duration).valid_for_minutes, duration)
        self.assertIsNone(PermissionDecision(decision="approved").valid_for_minutes)
        for duration in (0, -1, 241, 1000000, 20, 45, True, False, 15.0, 15.5, "15"):
            with self.subTest(duration=repr(duration)), self.assertRaises(ValidationError):
                PermissionDecision(decision="approved", valid_for_minutes=duration)

    async def test_shared_manual_duration_validation_rejects_invalid_pending_and_retry_calls_before_mutation(self):
        for status in ("pending", "approved"):
            for duration in (0, -1, 241, 1000000, 20, 45, True, False, 15.0, 15.5, "15", float("inf"), float("nan")):
                with self.subTest(status=status, duration=repr(duration)):
                    saved = {"id": "req", "type": "manual_override", "status": status,
                        "validFrom": "2026-01-01T00:00:00Z", "validTo": "2026-01-01T01:00:00Z",
                        **({"appliedAt": "2026-01-01T00:00:00Z"} if status == "approved" else {})}
                    req = PermissionRequestModel(id="req", subject_id=None, data=dict(saved))
                    db = session()
                    db.scalar.return_value = req
                    with patch("permission_decisions._prepare_manual_approval_subject", new=AsyncMock()) as approval:
                        with self.assertRaises(HTTPException) as error:
                            await apply_permission_decision(db, "req", "approved", "admin", "Checked", valid_for_minutes=duration)
                        self.assertEqual(error.exception.status_code, 422)
                        approval.assert_not_awaited()
                    self.assertEqual(req.data, saved)
                    db.scalar.assert_awaited_once()
                    db.flush.assert_not_awaited()
                    db.commit.assert_not_awaited()

    async def test_visitor_and_zone_approvals_preserve_requested_dates_and_zones(self):
        for kind in ("visitor", "zone_access"):
            with self.subTest(kind=kind):
                start = "2026-12-01T08:00:00+05:30"
                end = "2026-12-01T17:00:00+05:30"
                req = PermissionRequestModel(id="req", subject_id="person", data={
                    "id": "req", "type": kind, "status": "pending", "subjectName": "Guest",
                    "requestedZones": ["public", "secure"], "validFrom": start, "validTo": end,
                })
                subject = Subject(id="person", barcode="person", kind="visitor" if kind == "visitor" else "employee",
                    person=Person(data={"name": "Guest", "status": "pending_approval"}))
                permission = AccessPermission(id="permission", subject_id="person", data={"zones": ["secure"]})
                if kind == "zone_access":
                    req.data["permissionVersion"] = zone_permission_version(permission, subject.person.data)
                db = session()
                db.scalar.side_effect = [req, None, subject, permission]
                result = await apply_permission_decision(db, "req", "approved", "admin", "Checked", valid_for_minutes=60)
                self.assertEqual((result["permission"]["validFrom"], result["permission"]["validTo"]), (start, end))
                self.assertEqual(result["permission"]["zones"], ["public", "secure"])
                self.assertEqual(subject.person.data["allowedZones"], ["public", "secure"])
                self.assertNotIn("terminalAcknowledgementRequired", result["request"])

    async def test_manual_approval_retains_admin_duration(self):
        req = PermissionRequestModel(id="req", subject_id=None, data={
            "id": "req", "type": "manual_override", "status": "pending", "subjectName": "Unknown",
            "validFrom": "2026-01-01T00:00:00Z", "validTo": "2026-01-01T01:00:00Z",
        }, created_at=datetime.now(timezone.utc))
        subject = Subject(id="person", barcode="unknown", kind="visitor",
            person=Person(data={"name": "Unknown", "inside": False}))
        db = session()
        db.scalar.side_effect = [req, None, None]
        async def prepare(_db, request, data):
            request.subject_id = subject.id
            request.data = {**data, "subjectId": subject.id, "subjectType": subject.kind, "barcode": subject.barcode}
            return subject
        with patch("permission_decisions._prepare_manual_approval_subject", new=AsyncMock(side_effect=prepare)), \
             patch("permission_decisions.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            result = await apply_permission_decision(db, "req", "approved", "admin", "Checked", valid_for_minutes=120)
        approved = result["request"]
        self.assertEqual(datetime.fromisoformat(approved["validTo"]) - datetime.fromisoformat(approved["validFrom"]), timedelta(hours=2))
        self.assertIsNone(result["movement"])
        self.assertFalse(subject.person.data["inside"])
        self.assertNotIn("terminalAcknowledgementRequired", approved)
        self.assertNotIn("notificationDismissedAt", approved)

    async def test_custody_approval_reassigns_employee_without_expiry_or_access_grant(self):
        asset = HardwareAsset(subject_id="asset", data={"name": "Laptop", "assignedEmployeeId": "old", "allowedZones": ["public"]})
        subject = Subject(id="asset", barcode="asset", kind="hardware", hardware=asset)
        carrier = Subject(id="employee", barcode="employee", kind="employee")
        carrier_data = Person(subject_id="employee", data={"name": "Verified employee"})
        req = PermissionRequestModel(id="req", subject_id="asset", data={
            "id": "req", "type": "hardware_custody", "status": "pending", "hardwareId": "asset",
            "carrierId": "employee", "carrierName": "Spoofed name", "subjectName": "Laptop", "validFrom": "", "validTo": "",
        })
        req.data["custodyVersion"] = custody_version(asset.data)
        db = session()
        db.scalar.side_effect = [req, None, subject, asset]
        db.get.side_effect = [carrier, carrier_data]
        result = await apply_permission_decision(db, "req", "approved", "admin", "Checked", valid_for_minutes=60)
        self.assertEqual(asset.data["assignedEmployeeId"], "employee")
        self.assertEqual(asset.data["assignedEmployeeName"], "Verified employee")
        self.assertEqual(asset.data["allowedZones"], ["public"])
        self.assertIsNone(result["permission"])
        self.assertEqual(result["request"]["validTo"], "")

    async def test_create_custody_validates_employee_and_captures_existing_assignment(self):
        subject = Subject(id="asset", kind="hardware", barcode="asset")
        asset = HardwareAsset(subject_id="asset", data={"name": "Laptop", "assignedEmployeeId": "old", "assignedEmployeeName": "Old employee"})
        checkpoint = Checkpoint(id="cp-main", data={"name": "Main Entrance", "zone": "public"})
        employee = Subject(id="employee", kind="employee", barcode="employee")
        person = Person(subject_id="employee", data={"name": "New employee"})
        db = session()
        db.execute.side_effect = [scalar_result(subject), scalar_result(asset)]
        db.get.side_effect = [checkpoint, checkpoint, subject, employee, employee, person]
        payload = PermissionRequestCreate(subject_id="asset", checkpoint_id="cp-main", request_type="hardware_custody", reason="Transfer", carrier_id="employee", carrier_name="Forged")
        with patch("routers.permissions.enqueue_decision", new=AsyncMock()) as enqueue:
            result = await create_permission_request(payload, db, {"sub": "admin", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(result["previousCarrierName"], "Old employee")
        self.assertEqual(result["carrierName"], "New employee")
        self.assertEqual((result["validFrom"], result["validTo"], result["requestedZones"]), ("", "", []))
        self.assertEqual(enqueue.await_args.args, (db, {"request": result}))
        db.add.assert_called_once()
        db.commit.assert_awaited_once()

    async def test_create_custody_rejects_non_employee(self):
        db = session()
        db.execute.side_effect = [scalar_result(Subject(id="asset", kind="hardware", barcode="asset")), scalar_result(HardwareAsset(data={"name": "Laptop"}))]
        checkpoint = Checkpoint(id="cp-main", data={"zone": "public"})
        asset_subject = Subject(id="asset", kind="hardware", barcode="asset")
        visitor = Subject(id="visitor", kind="visitor", barcode="visitor")
        db.get.side_effect = [checkpoint, checkpoint, asset_subject, visitor]
        payload = PermissionRequestCreate(subject_id="asset", checkpoint_id="cp-main", request_type="hardware_custody", reason="Transfer", carrier_id="visitor")
        with self.assertRaises(HTTPException) as error:
            await create_permission_request(payload, db, {"sub": "admin", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(error.exception.status_code, 422)
        db.commit.assert_not_awaited()

    async def test_zone_request_requires_complete_zone_set(self):
        db = session()
        db.execute.side_effect = [scalar_result(Subject(id="employee", kind="employee", barcode="employee")), scalar_result(Person(data={"name": "Employee"}))]
        db.get.return_value = Checkpoint(id="cp-main", data={"zone": "public"})
        payload = PermissionRequestCreate(subject_id="employee", checkpoint_id="cp-main", request_type="zone_access", reason="Lab access", requested_zones=[])
        with self.assertRaises(HTTPException) as error:
            await create_permission_request(payload, db, {"sub": "admin", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(error.exception.status_code, 422)
        db.commit.assert_not_awaited()

    async def test_visitor_create_reuses_pending_request(self):
        existing = PermissionRequestModel(id="existing", data={"id": "existing", "type": "visitor", "status": "pending"})
        db = session()
        db.execute.return_value = scalar_result(Subject(id="visitor", kind="visitor", barcode="visitor"))
        db.scalar.return_value = existing
        db.get.return_value = Checkpoint(id="cp-main", data={"name": "Main Entrance", "zone": "public"})
        payload = PermissionRequestCreate(subject_id="visitor", checkpoint_id="cp-main", request_type="visitor", reason="Visit")
        result = await create_permission_request(payload, db, {"sub": "admin", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(result["id"], "existing")
        db.add.assert_not_called()

    async def test_publication_carries_request_access_permission_and_presence(self):
        event = decision_event({"request": {"id": "req", "subjectId": "visitor"}, "permission": {"id": "permission"}, "person": {"id": "visitor"}})
        self.assertEqual(set(event), {"type", "requestId", "subject_id", "movement", "request", "permission", "people", "hardwareAssets"})
        self.assertEqual(event["permission"], {"id": "permission"})
        self.assertEqual(event["people"], [{"id": "visitor"}])

    async def test_terminal_review_persists_before_publishing_pending_request(self):
        db = session()
        db.scalar.side_effect = [
            TerminalCheckpointAssignment(terminal_identity="browser:operator", checkpoint_id="cp-main"),
            None,
        ]
        db.get.return_value = Checkpoint(id="cp-main", data={"name": "Main Entrance", "zone": "public"})
        source = Mock(
            subject_id=None,
            occurred_at=datetime.now(timezone.utc),
            direction="entry",
            data={"barcode": "unknown"},
        )
        payload = ManualReviewPayload(
            barcode="unknown", checkpointId="cp-main", eventId="denied-scan",
            operatorNote="Checked photo ID",
        )
        with patch("routers.terminal.review_source", new=AsyncMock(return_value=source)), patch("routers.terminal.pending_manual_review", new=AsyncMock(return_value=None)), patch("routers.terminal.enqueue_presence", new=AsyncMock()) as enqueue:
            request = await create_manual_review(payload, db, {"sub": "operator"})
        db.add.assert_called_once()
        db.commit.assert_awaited_once()
        self.assertIs(enqueue.await_args.args[0], db)
        message = enqueue.await_args.args[1]
        self.assertEqual(set(message), {"type", "requestId", "request"})
        self.assertEqual(message["requestId"], request["id"])
        self.assertEqual(message["request"]["operatorNote"], "Checked photo ID")
