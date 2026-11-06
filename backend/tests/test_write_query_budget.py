"""Write query reductions keep checkpoint scope, retirement locks and entry holds."""
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from models import Checkpoint, HardwareAsset, OrganizationZone, Person, PresenceState, Subject
from routers.registry import _validate_checkpoint_grants
from schemas import BrowserScanPayload
from terminal_scans import record_scan


class Rows(list):
    def all(self):
        return list(self)


ACTOR = {"sub": "admin", "realm_access": {"roles": ["zone-admin"]}}


class CheckpointGrantQueryTests(unittest.IsolatedAsyncioTestCase):
    def session(self, checkpoints, zones):
        return SimpleNamespace(scalars=AsyncMock(side_effect=[Rows(checkpoints), Rows(zones)]))

    async def test_many_checkpoint_grants_use_two_reads_and_shared_zone_locks(self):
        ids = [f"a-{index}" for index in range(16)]
        db = self.session([Checkpoint(id=value, zone_id="a", active=True) for value in ids],
            [OrganizationZone(id="a", active=True)])
        with patch("routers.registry.admin_zone_ids", new=AsyncMock()) as scope:
            result = await _validate_checkpoint_grants(db, ACTOR, ids, ["a"],
                kind="employee", actor_zones=("a",))
        self.assertEqual(result, ids)
        self.assertEqual(db.scalars.await_count, 2)
        scope.assert_not_awaited()
        lock_query = db.scalars.await_args_list[1].args[0]
        self.assertTrue(lock_query._for_update_arg.read)
        self.assertIn("organization_zones.id", str(lock_query._order_by_clauses[0]))

    async def test_standalone_validation_resolves_actor_scope_once(self):
        db = self.session([Checkpoint(id=value, zone_id="a", active=True) for value in ("a-1", "a-2")],
            [OrganizationZone(id="a", active=True)])
        with patch("routers.registry.admin_zone_ids", new=AsyncMock(return_value=("a",))) as scope:
            await _validate_checkpoint_grants(db, ACTOR, ["a-1", "a-2"], ["a"], kind="employee")
        scope.assert_awaited_once_with(db, ACTOR)

    async def test_missing_inactive_foreign_and_outside_grant_checkpoints_fail_closed(self):
        cases = (
            ([], [], ("a",), ["a"], 422),
            ([Checkpoint(id="a-1", zone_id="a", active=False)], [OrganizationZone(id="a", active=True)], ("a",), ["a"], 422),
            ([Checkpoint(id="a-1", zone_id="a", active=True)], [], ("a",), ["a"], 422),
            ([Checkpoint(id="a-1", zone_id="a", active=True)], [OrganizationZone(id="a", active=False)], ("a",), ["a"], 422),
            ([Checkpoint(id="a-1", zone_id="a", active=True)], [OrganizationZone(id="a", active=True)], ("b",), ["a"], 403),
            ([Checkpoint(id="a-1", zone_id="a", active=True)], [OrganizationZone(id="a", active=True)], ("a",), ["b"], 422),
        )
        for checkpoints, zones, allowed, requested, status in cases:
            with self.subTest(status=status, checkpoints=checkpoints):
                db = self.session(checkpoints, zones)
                with self.assertRaises(HTTPException) as raised:
                    await _validate_checkpoint_grants(db, ACTOR, ["a-1"], requested,
                        kind="employee", actor_zones=allowed)
                self.assertEqual(raised.exception.status_code, status)

    async def test_empty_employee_selector_needs_no_reads_and_visitor_still_requires_one(self):
        db = self.session([], [])
        self.assertEqual(await _validate_checkpoint_grants(db, ACTOR, [], ["a"], kind="employee"), [])
        for ids in ([], ["a-1", "a-2"]):
            with self.assertRaises(HTTPException) as raised:
                await _validate_checkpoint_grants(db, ACTOR, ids, ["a"], kind="visitor")
            self.assertEqual(raised.exception.status_code, 422)
        db.scalars.assert_not_awaited()


class ScanManualGrantQueryTests(unittest.IsolatedAsyncioTestCase):
    async def scan(self, *, direction="entry", held_subject=None, hardware=False):
        subject = Subject(id="person", barcode="EMP", kind="employee", person=Person(data={
            "name": "Employee", "status": "active", "allowedZones": ["a"], "inside": direction == "exit"}))
        subjects = [subject]
        if hardware:
            subjects.append(Subject(id="asset", barcode="HW", kind="hardware", hardware=HardwareAsset(data={
                "name": "Laptop", "status": "active", "allowedZones": ["a"],
                "assignedEmployeeId": "person", "inside": direction == "exit"})))
        checkpoint = Checkpoint(id="a-1", zone_id="a", number=1, active=True, required=False,
            gate_type="entry_exit", data={"name": "Entrance", "mode": direction})
        states = [PresenceState(subject_id=item.id, state="inside" if direction == "exit" else "outside",
            entry_building_id="a" if direction == "exit" else None) for item in subjects]
        lookup = SimpleNamespace(scalar_one_or_none=lambda: subject)
        rows = lambda values: SimpleNamespace(scalars=lambda: Rows(values))
        db = SimpleNamespace(info={}, execute=AsyncMock(side_effect=[None, lookup, rows(subjects), rows([]), None, rows(states)]),
            get=AsyncMock(side_effect=[None, checkpoint]), flush=AsyncMock(), add=Mock())
        restrictions = {held_subject: {"subjectId": held_subject, "active": True}} if held_subject else {}
        with patch("terminal_scans.entry_restrictions_for_locked_subjects", new=AsyncMock(return_value=restrictions)), \
             patch("terminal_scans._approved_manual_review", new=AsyncMock(return_value=None)) as grants:
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="EMP", checkpointId="a-1",
                direction=direction, selectedHardwareIds=["asset"] if hardware else []), "browser:operator",
                validated_checkpoint_id="a-1")
        return result, grants, states

    async def test_person_and_carried_asset_holds_skip_unused_grants_and_preserve_denial(self):
        for held_subject, hardware in (("person", False), ("asset", True)):
            with self.subTest(held_subject=held_subject):
                result, grants, states = await self.scan(held_subject=held_subject, hardware=hardware)
                self.assertFalse(result["allowed"])
                self.assertEqual(result["decision"]["event"]["denialCode"],
                    "hardware_restricted" if hardware else "access_restricted")
                self.assertEqual(result["decision"]["entryRestrictions"][0]["subjectId"], held_subject)
                self.assertEqual({state.state for state in states}, {"outside"})
                grants.assert_not_awaited()

    async def test_held_exits_and_unrestricted_entries_still_check_manual_grants(self):
        for direction, held_subject in (("exit", "person"), ("entry", None)):
            with self.subTest(direction=direction):
                result, grants, _ = await self.scan(direction=direction, held_subject=held_subject)
                self.assertTrue(result["allowed"], result)
                grants.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
