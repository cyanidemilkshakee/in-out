"""Retired employee metadata cannot return through writes, reads or live updates."""
import copy
import json
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models import AccessPermission, Checkpoint, Person, PresenceState, ScanRequest, Subject, PermissionRequestModel
from schemas import BrowserScanPayload, SubjectCreate, SubjectUpdate
from routers.registry import create_subject, get_subject, list_subjects, registry_bundle, update_subject
from routers.permissions import list_permissions
from permission_decisions import apply_permission_decision, publish_decision
from terminal_scans import record_scan


ADMIN = {"sub": "admin", "realm_access": {"roles": ["admin"]}}


def rows(values=(), scalar=None):
    result = Mock()
    result.scalar_one.return_value = scalar
    result.scalar_one_or_none.return_value = scalar
    result.scalars.return_value.all.return_value = list(values)
    result.all.return_value = list(values)
    return result


def session():
    return Mock(execute=AsyncMock(), scalar=AsyncMock(return_value=None), get=AsyncMock(),
                flush=AsyncMock(), commit=AsyncMock(), refresh=AsyncMock(), rollback=AsyncMock(), info={})


def legacy_employee():
    # Relational kind remains authoritative even when old editable JSON disagrees.
    return Subject(id="employee", kind="employee", barcode="EMP-1", person=Person(data={
        "name": "Alice", "type": "visitor", "department": "Operations", "accessLevel": "Admin",
        "allowedZones": ["public"], "status": "active", "inside": False,
        "validFrom": "2026-01-01T00:00:00Z", "validTo": "",
    }))


class SubjectMetadataTests(unittest.IsolatedAsyncioTestCase):
    def assert_retired_absent(self, data):
        self.assertNotIn("department", data)
        self.assertNotIn("accessLevel", data)

    async def test_create_discards_stale_fields_without_rejecting_or_changing_zones(self):
        db = session()
        added = []
        db.add.side_effect = added.append
        payload = SubjectCreate(kind="employee", barcode="EMP-NEW", data={
            "name": "Alice", "allowedZones": ["public"], "department": {"stale": "value"},
            "accessLevel": ["Admin"], "type": "visitor",
        })
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            result = await create_subject(payload, db, ADMIN)
        self.assert_retired_absent(result.data)
        self.assertEqual(result.data["allowedZones"], ["public"])
        self.assertEqual(result.data["type"], "employee")
        subject = next(item for item in added if isinstance(item, Subject))
        self.assert_retired_absent(subject.person.data)
        permission = next(item for item in added if isinstance(item, AccessPermission))
        self.assertEqual(permission.data["zones"], ["public"])
        db.commit.assert_awaited_once()

    async def test_update_discards_stale_fields_and_preserves_real_policy_changes(self):
        subject = legacy_employee()
        permission = AccessPermission(id="perm", subject_id=subject.id, data={"zones": ["public"], "state": "active"})
        db = session()
        db.execute.return_value = rows(scalar=subject)
        db.scalar.return_value = permission
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            result = await update_subject(subject.id, SubjectUpdate(data={
                "department": 123, "accessLevel": "Elevated", "allowedZones": ["secure"], "status": "restricted",
            }), db, ADMIN)
        self.assert_retired_absent(subject.person.data)
        self.assert_retired_absent(result.data)
        self.assertEqual(result.data["allowedZones"], ["secure"])
        self.assertEqual((permission.data["zones"], permission.data["state"]), (["secure"], "restricted"))

    async def test_barcode_only_update_also_cleans_legacy_current_metadata(self):
        subject = legacy_employee()
        db = session()
        db.execute.return_value = rows(scalar=subject)
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            result = await update_subject(subject.id, SubjectUpdate(barcode="EMP-RENAMED"), db, ADMIN)
        self.assert_retired_absent(subject.person.data)
        self.assert_retired_absent(result.data)
        self.assertEqual(result.data["barcode"], "EMP-RENAMED")
        self.assertEqual(result.data["allowedZones"], ["public"])

    async def test_legacy_get_list_bundle_and_permission_subjects_hide_retired_fields_before_migration(self):
        subject = legacy_employee()
        original = copy.deepcopy(subject.person.data)
        db = session()
        db.execute.return_value = rows(scalar=subject)
        single = await get_subject(subject.id, db, ADMIN)
        self.assert_retired_absent(single.data)
        db.execute.side_effect = [rows(scalar=1), rows([subject])]
        listed = await list_subjects(None, 50, 0, db, ADMIN)
        self.assert_retired_absent(listed.items[0].data)
        db.execute.side_effect = [rows([subject]), *[rows() for _ in range(7)]]
        with patch("critical_entry_restrictions.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            bundle = await registry_bundle(db)
        self.assert_retired_absent(bundle["people"][0])
        self.assertEqual(bundle["people"][0]["type"], "employee")
        db.execute.side_effect = [rows(), rows(), rows(), rows([subject]), rows()]
        with patch("critical_entry_restrictions.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            permissions = await list_permissions(db, ADMIN)
        self.assert_retired_absent(permissions["subjects"][0])
        self.assertEqual(permissions["people"][0]["zones"], ["public"])
        self.assertEqual(subject.person.data, original, "Read serialization must not mutate database history or current rows")

    async def test_fresh_approved_and_denied_scans_hide_fields_and_preserve_access_behavior(self):
        for restricted in (False, True):
            with self.subTest(restricted=restricted):
                subject = legacy_employee()
                if restricted:
                    subject.person.data["status"] = "restricted"
                checkpoint = Checkpoint(id="cp-main", data={"name": "Main Entrance", "zone": "public"})
                presence = PresenceState(subject_id=subject.id, state="outside", last_scan_timestamp=None)
                db = session()
                db.get.side_effect = [None, checkpoint]
                db.execute.side_effect = [rows(), rows(scalar=subject), rows([subject]), rows(), rows(), rows(scalar=presence)]
                with patch("terminal_scans.entry_restrictions_for_subjects", new=AsyncMock(return_value={})), \
                     patch("terminal_scans._approved_manual_review", new=AsyncMock(return_value=None)):
                    result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode=subject.barcode, checkpointId="cp-main"), "operator")
                self.assertEqual(result["allowed"], not restricted)
                self.assert_retired_absent(result["decision"]["subject"])
                self.assert_retired_absent(result["updatedPeople"][0])
                self.assertEqual(result["updatedPeople"][0]["allowedZones"], ["public"])

    async def test_legacy_scan_replay_hides_employee_fields_without_rewriting_snapshot(self):
        subject = legacy_employee()
        snapshot = {"allowed": False, "decision": {"event": {"direction": "entry"},
                    "subject": subject.person.data}, "updatedPeople": [{**subject.person.data, "id": subject.id}]}
        saved = copy.deepcopy(snapshot)
        key = uuid.uuid4()
        db = session()
        cached = ScanRequest(idempotency_key=key, subject_id=subject.id, terminal_id="operator", response_body=snapshot)
        db.get.side_effect = [cached, subject]
        result = await record_scan(db, key, BrowserScanPayload(barcode=subject.barcode, checkpointId="cp-main"), "operator")
        self.assert_retired_absent(result["decision"]["subject"])
        self.assert_retired_absent(result["updatedPeople"][0])
        self.assertEqual(cached.response_body, saved)
        self.assertTrue(db.info["scan_replayed"])

    async def test_zone_approval_result_and_live_person_do_not_resurrect_legacy_fields(self):
        subject = legacy_employee()
        now = datetime.now(timezone.utc)
        start, end = (now + timedelta(days=1)).isoformat(), (now + timedelta(days=2)).isoformat()
        request = PermissionRequestModel(id="request", subject_id=subject.id, data={
            "id": "request", "type": "zone_access", "status": "pending", "subjectName": "Alice",
            "requestedZones": ["secure"], "validFrom": start, "validTo": end,
        })
        permission = AccessPermission(id="perm", subject_id=subject.id, data={"zones": ["public"]})
        db = session()
        db.scalar.side_effect = [request, None, subject, permission]
        with patch("permission_decisions.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            result = await apply_permission_decision(db, request.id, "approved", "admin", "Confirmed")
        self.assert_retired_absent(result["person"])
        self.assert_retired_absent(subject.person.data)
        self.assertEqual(result["person"]["allowedZones"], ["secure"])
        self.assertEqual(result["permission"]["validTo"], end)
        with patch("permission_decisions.publish_presence_update", new=AsyncMock()) as publish:
            await publish_decision(result)
        event = json.loads(publish.await_args.args[0])
        self.assert_retired_absent(event["people"][0])


if __name__ == "__main__":
    unittest.main()
