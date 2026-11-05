"""Checkpoint selectors cannot widen zone access; Registry writes retain audit history."""
import copy
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from models import AccessPermission, AuditEvent, Checkpoint, HardwareAsset, OrganizationZone, Person, Subject
from movement_logic import evaluate_scan
from registry_validation import validated_checkpoint_ids
from routers import registry
from schemas import SubjectCreate, SubjectUpdate


ACTOR = {"sub": "zone-a-admin", "realm_access": {"roles": ["zone-admin"]}}


class ScalarRows(list):
    def all(self):
        return list(self)


def session(subject=None, permission=None, checkpoints=None):
    checkpoints = checkpoints or {
        "a-1": Checkpoint(id="a-1", zone_id="a", active=True),
        "b-1": Checkpoint(id="b-1", zone_id="b", active=True),
    }
    result = Mock()
    result.scalar_one_or_none.return_value = subject

    async def get(model, identity, **kwargs):
        return checkpoints.get(identity) if model is Checkpoint else None

    async def scalar(query):
        sql = str(query)
        if "organization_zones" in sql:
            value = list(query.compile().params.values())[0]
            return OrganizationZone(id=value, name=value, active=True)
        return permission

    return Mock(execute=AsyncMock(return_value=result), scalar=AsyncMock(side_effect=scalar),
                scalars=AsyncMock(return_value=ScalarRows(["a"])), get=AsyncMock(side_effect=get),
                add=Mock(), flush=AsyncMock(), commit=AsyncMock(), refresh=AsyncMock(),
                rollback=AsyncMock(), info={})


def employee():
    return Subject(id="employee-a", kind="employee", barcode="EMP-A", person=Person(data={
        "id": "employee-a", "barcode": "EMP-A", "name": "Alice", "type": "employee",
        "status": "active", "allowedZones": ["a"], "inside": False,
    }))


class CheckpointPolicyTests(unittest.TestCase):
    def scan(self, metadata, checkpoint):
        return evaluate_scan(barcode="EMP-A", checkpoint=checkpoint,
            people=[{"id": "employee-a", "barcode": "EMP-A", "name": "Alice", "type": "employee",
                     "status": "active", "inside": False, **metadata}],
            hardware=[], selected_hardware_ids=[], online=True, event_count=0, scan_type="auto")["event"]

    def test_legacy_checkpoint_selector_cannot_override_permitted_zones(self):
        result = self.scan({"allowedZones": ["a"], "allowedCheckpoints": ["b-1"]},
                           {"id": "b-1", "zone": "b", "mode": "entry"})
        self.assertEqual(result["result"], "denied")
        self.assertEqual(result["denialCode"], "zone_not_permitted")

    def test_checkpoint_selector_narrows_allowed_zone(self):
        subject = {"allowedZones": ["a"], "allowedCheckpoints": ["a-1"]}
        self.assertEqual(self.scan(subject, {"id": "a-1", "zone": "a", "mode": "entry"})["result"], "approved")
        self.assertEqual(self.scan(subject, {"id": "a-2", "zone": "a", "mode": "entry"})["result"], "denied")
        self.assertEqual(self.scan({"allowedZones": ["a"], "allowedCheckpoints": []},
                                  {"id": "a-2", "zone": "a", "mode": "entry"})["result"], "approved")

    def test_checkpoint_selectors_are_bounded_typed_and_unique(self):
        self.assertEqual(validated_checkpoint_ids([" a-1 "]), ["a-1"])
        for value in (None, "a-1", [7], [""], ["../b-1"], ["a-1", " a-1 "], ["a-1"] * 17):
            with self.subTest(value=value), self.assertRaises(HTTPException) as caught:
                validated_checkpoint_ids(value)
            self.assertEqual(caught.exception.status_code, 422)


class RegistryCheckpointSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        changed = patch("routers.registry.enqueue_changed", new=AsyncMock(return_value=1))
        changed.start()
        self.addCleanup(changed.stop)

    async def test_create_rejects_other_zone_checkpoint_before_any_writes(self):
        db = session()
        with self.assertRaises(HTTPException) as caught:
            await registry.create_subject(SubjectCreate(kind="employee", barcode="EMP-A", data={
                "name": "Alice", "allowedZones": ["a"], "allowedCheckpoints": ["b-1"]}), db, ACTOR)
        self.assertEqual(caught.exception.status_code, 403)
        db.add.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_update_rejects_other_zone_checkpoint_without_changing_subject(self):
        subject = employee()
        original = copy.deepcopy(subject.person.data)
        db = session(subject)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
            with self.assertRaises(HTTPException) as caught:
                await registry.update_subject(subject.id, SubjectUpdate(data={"allowedCheckpoints": ["b-1"]}), db, ACTOR)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(subject.person.data, original)
        db.add.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_clearing_checkpoints_cannot_widen_shared_canonical_grant(self):
        for metadata_zones in (["a", "b"], ["a"]):
            subject = employee()
            subject.person.data = {**subject.person.data, "allowedZones": metadata_zones}
            permission = AccessPermission(id="permission", subject_id=subject.id,
                data={"state": "active", "zones": ["a", "b"], "checkpoints": ["a-1", "b-1"]})
            original, original_permission = copy.deepcopy(subject.person.data), copy.deepcopy(permission.data)
            db = session(subject, permission)
            with self.subTest(metadata_zones=metadata_zones), \
                 patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
                with self.assertRaises(HTTPException) as caught:
                    await registry.update_subject(subject.id, SubjectUpdate(data={"allowedCheckpoints": []}), db, ACTOR)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(subject.person.data, original)
            self.assertEqual(permission.data, original_permission)
            db.add.assert_not_called()
            db.commit.assert_not_awaited()

    async def test_reactivation_and_window_widening_cannot_grant_foreign_zone_access(self):
        now = datetime.now(timezone.utc)
        old_from, old_to = now.isoformat(), (now + timedelta(hours=1)).isoformat()
        cases = (("restricted", {"status": "active"}),
                 ("active", {"validFrom": (now - timedelta(minutes=1)).isoformat()}),
                 ("active", {"validTo": (now + timedelta(hours=2)).isoformat()}))
        for state, changes in cases:
            subject = employee()
            # Deliberately different metadata: enforcement must use canonical
            # state/window/zones instead of trusting this active A-only mirror.
            subject.person.data = {**subject.person.data, "validFrom": old_from, "validTo": old_to}
            permission = AccessPermission(id="permission", subject_id=subject.id,
                data={"state": state, "zones": ["a", "b"], "validFrom": old_from, "validTo": old_to})
            original, original_permission = copy.deepcopy(subject.person.data), copy.deepcopy(permission.data)
            db = session(subject, permission)
            with self.subTest(changes=changes), patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
                with self.assertRaises(HTTPException) as caught:
                    await registry.update_subject(subject.id, SubjectUpdate(data=changes), db, ACTOR)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(subject.person.data, original)
            self.assertEqual(permission.data, original_permission)
            db.add.assert_not_called()
            db.commit.assert_not_awaited()

    async def test_explicit_own_zone_narrowing_can_clear_checkpoints_and_reactivate(self):
        subject = employee()
        subject.person.data = {**subject.person.data, "allowedZones": ["a", "b"], "status": "restricted"}
        permission = AccessPermission(id="permission", subject_id=subject.id,
            data={"state": "restricted", "zones": ["a", "b"], "checkpoints": ["a-1", "b-1"]})
        db = session(subject, permission)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
            await registry.update_subject(subject.id, SubjectUpdate(data={
                "allowedZones": ["a"], "allowedCheckpoints": [], "status": "active"}), db, ACTOR)
        self.assertEqual(permission.data["zones"], ["a"])
        self.assertEqual(permission.data["checkpoints"], [])
        self.assertEqual(permission.data["state"], "active")
        db.commit.assert_awaited_once()

    async def test_custody_transfer_cannot_grant_shared_hardware_at_unmanaged_zone(self):
        for field in ("ownerId", "assignedEmployeeId"):
            subject = Subject(id="asset", kind="hardware", barcode="HW-A", hardware=HardwareAsset(data={
                "name": "Laptop", "category": "Laptop", "status": "active", "allowedZones": ["a", "b"],
                "ownerId": "old-employee", "assignedEmployeeId": "old-employee"}))
            permission = AccessPermission(id="permission", subject_id=subject.id,
                data={"state": "active", "zones": ["a", "b"]})
            original = copy.deepcopy(subject.hardware.data)
            db = session(subject, permission)
            with self.subTest(field=field), \
                 patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)), \
                 patch("routers.registry._hardware_employee", new=AsyncMock(return_value=("new-employee", "New employee"))):
                with self.assertRaises(HTTPException) as caught:
                    await registry.update_subject(subject.id, SubjectUpdate(data={field: "new-employee"}), db, ACTOR)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(subject.hardware.data, original)
            db.add.assert_not_called()
            db.commit.assert_not_awaited()

    async def test_hardware_custody_transfer_is_allowed_after_explicit_own_zone_narrowing(self):
        subject = Subject(id="asset", kind="hardware", barcode="HW-A", hardware=HardwareAsset(data={
            "name": "Laptop", "category": "Laptop", "status": "active", "allowedZones": ["a", "b"],
            "ownerId": "old-employee", "assignedEmployeeId": "old-employee"}))
        permission = AccessPermission(id="permission", subject_id=subject.id,
            data={"state": "active", "zones": ["a", "b"]})
        db = session(subject, permission)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)), \
             patch("routers.registry._hardware_employee", new=AsyncMock(return_value=("new-employee", "New employee"))):
            await registry.update_subject(subject.id, SubjectUpdate(data={
                "allowedZones": ["a"], "assignedEmployeeId": "new-employee"}), db, ACTOR)
        self.assertEqual(subject.hardware.data["assignedEmployeeId"], "new-employee")
        self.assertEqual(permission.data["zones"], ["a"])
        db.commit.assert_awaited_once()

    async def test_restrictive_status_and_window_edits_preserve_shared_legacy_grant(self):
        now = datetime.now(timezone.utc)
        for changes in ({"status": "inactive"}, {"validTo": (now + timedelta(hours=1)).isoformat()},
                        {"validFrom": (now + timedelta(minutes=1)).isoformat()}):
            subject = employee()
            subject.person.data = {**subject.person.data, "allowedZones": ["a", "b"],
                "validFrom": now.isoformat(), "validTo": (now + timedelta(hours=2)).isoformat()}
            permission = AccessPermission(id="permission", subject_id=subject.id, data={
                "state": "active", "zones": ["a", "b"], "validFrom": now.isoformat(),
                "validTo": (now + timedelta(hours=2)).isoformat()})
            db = session(subject, permission)
            with self.subTest(changes=changes), patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
                await registry.update_subject(subject.id, SubjectUpdate(data=changes), db, ACTOR)
            db.commit.assert_awaited_once()

    async def test_missing_inactive_and_wrong_subject_zone_checkpoints_fail(self):
        for checkpoint, zones, status in ((None, ["a"], 422),
                (Checkpoint(id="a-1", zone_id="a", active=False), ["a"], 422),
                (Checkpoint(id="a-1", zone_id="a", active=True), ["b"], 422)):
            db = session(checkpoints={"a-1": checkpoint})
            with self.subTest(checkpoint=checkpoint, zones=zones), self.assertRaises(HTTPException) as caught:
                await registry._validate_checkpoint_grants(db, ACTOR, ["a-1"], zones, kind="employee")
            self.assertEqual(caught.exception.status_code, status)

    async def test_valid_checkpoint_is_written_to_canonical_permission_and_audit(self):
        subject = employee()
        permission = AccessPermission(id="permission-a", subject_id=subject.id,
                                      data={"state": "active", "zones": ["a"]})
        db = session(subject, permission)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
            await registry.update_subject(subject.id, SubjectUpdate(data={
                "allowedCheckpoints": ["a-1"], "name": "\t Alice "}), db, ACTOR)
        self.assertEqual(permission.data["checkpoints"], ["a-1"])
        self.assertEqual(subject.person.data["allowedCheckpoints"], ["a-1"])
        self.assertEqual(subject.person.data["name"], "Alice")
        audits = [call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], AuditEvent)]
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0].data["actor"], ACTOR["sub"])
        self.assertEqual(audits[0].data["before"]["allowedZones"], ["a"])
        self.assertEqual(audits[0].data["after"]["allowedCheckpoints"], ["a-1"])
        db.commit.assert_awaited_once()

    async def test_create_keeps_checkpoint_permission_and_audit_in_same_transaction(self):
        db = session()
        await registry.create_subject(SubjectCreate(kind="employee", barcode="EMP-A", data={
            "name": "Alice", "allowedZones": ["a"], "allowedCheckpoints": ["a-1"],
            "privateExtension": "must not enter audit history"}), db, ACTOR)
        rows = [call.args[0] for call in db.add.call_args_list]
        permission = next(row for row in rows if isinstance(row, AccessPermission))
        audit = next(row for row in rows if isinstance(row, AuditEvent))
        self.assertEqual(permission.data["checkpoints"], ["a-1"])
        self.assertNotIn("privateExtension", audit.data["after"])
        self.assertEqual(audit.data["zoneId"], "a")
        db.commit.assert_awaited_once()

    async def test_delete_retains_security_snapshot_scoped_after_subject_is_gone(self):
        subject = employee()
        db = session(subject)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
            await registry.delete_subject(subject.id, db, ACTOR)
        audit = next(call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], AuditEvent))
        self.assertEqual(audit.data["action"], "Registry subject deleted")
        self.assertEqual(audit.data["zoneId"], "a")
        self.assertEqual(audit.data["before"]["barcode"], "EMP-A")
        self.assertNotIn("after", audit.data)
        db.commit.assert_awaited_once()

    async def test_pending_visitor_audit_uses_registration_branch_not_actor_branches(self):
        db = session()
        zones = await registry._registry_history_zones(db, "visitor-a", {
            "allowedZones": [], "checkpointId": "a-1"}, {"zones": [], "state": "pending_approval"})
        self.assertEqual(zones, {"a"})

    async def test_missing_deletion_audit_scope_returns_precise_conflict_before_delete(self):
        subject = employee()
        subject.person.data = {"name": "Legacy employee", "status": "active", "allowedZones": []}
        db = session(subject)
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)):
            with self.assertRaises(HTTPException) as caught:
                await registry.delete_subject(subject.id, db, ACTOR)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("audit scope", caught.exception.detail)
        self.assertEqual(db.execute.await_count, 1)  # Locked SELECT only, no DELETE.
        db.add.assert_not_called()
        db.commit.assert_not_awaited()
        db.rollback.assert_awaited_once()

    async def test_failed_audit_or_commit_rolls_back_registry_mutation(self):
        subject = employee()
        db = session(subject)
        db.commit.side_effect = RuntimeError("synthetic commit failure")
        with patch("routers.registry.require_subject_scope", new=AsyncMock(return_value=subject)), \
             self.assertLogs("routers.registry", level="ERROR"):
            with self.assertRaises(HTTPException) as caught:
                await registry.update_subject(subject.id, SubjectUpdate(data={"status": "inactive"}), db, ACTOR)
        self.assertEqual(caught.exception.status_code, 500)
        db.rollback.assert_awaited_once()

    async def test_visitor_checkpoint_requirement_is_preserved(self):
        db = session()
        self.assertEqual(await registry._validate_checkpoint_grants(db, ACTOR, ["a-1"], ["a"], kind="visitor"), ["a-1"])
        with self.assertRaises(HTTPException):
            await registry._validate_checkpoint_grants(db, ACTOR, [], ["a"], kind="visitor")


if __name__ == "__main__":
    unittest.main()
