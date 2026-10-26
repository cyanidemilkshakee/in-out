import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from movement_logic import evaluate_scan, _status_for
from access_validation import validate_window, validate_zones
from fastapi import HTTPException


class AccessPolicyTests(unittest.TestCase):
    def test_checkpoint_display_name_cannot_grant_zone_access(self):
        person = {"id": "p", "name": "Alice", "type": "employee", "barcode": "p", "inside": False,
            "status": "active", "allowedZones": ["a"]}
        event = evaluate_scan(barcode="p", checkpoint={"id": "b-1", "zone": "b", "name": "a", "mode": "entry"},
            people=[person], hardware=[], selected_hardware_ids=[], online=True, event_count=0, scan_type="auto")["event"]
        self.assertEqual(event["result"], "denied")
        self.assertEqual(event["denialCode"], "zone_not_permitted")

    def setUp(self):
        self.person = {"id": "p", "name": "Visitor", "type": "visitor", "barcode": "v", "inside": True,
            "status": "pending_approval", "allowedZones": [],
            "validTo": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "entryOverride": {"requestId": "manual-entry", "hardwareIds": [],
                "validTo": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()}}

    def scan(self, subject, hardware=None):
        return evaluate_scan(barcode=subject["barcode"], checkpoint={"id": "cp-main", "zone": "public", "mode": "auto"},
            people=[subject], hardware=hardware or [], selected_hardware_ids=[item["id"] for item in (hardware or [])],
            online=True, event_count=0, scan_type="auto")["event"]

    def test_manually_admitted_visitor_can_exit_after_permission_expiry(self):
        self.assertEqual(self.scan(self.person)["result"], "approved")
        self.assertEqual(self.scan({**self.person, "inside": False})["result"], "denied")

    def test_manual_exit_does_not_authorize_new_hardware(self):
        asset = {"id": "extra", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active", "inside": True, "allowedZones": ["public"]}
        self.assertEqual(self.scan(self.person, [asset])["result"], "denied")

    def test_manual_exit_preserves_reviewed_custody_but_rejects_later_changes(self):
        asset = {"id": "h", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active",
            "inside": True, "allowedZones": [], "assignedEmployeeId": "reviewed-other-owner"}
        person = {**self.person, "entryOverride": {"requestId": "review", "hardwareIds": ["h"],
            "hardwareCustody": {"h": {"ownerId": None, "assignedEmployeeId": "reviewed-other-owner"}}}}
        self.assertEqual(self.scan(person, [asset])["result"], "approved")
        for change in ({"assignedEmployeeId": "new-owner"}, {"status": "maintenance"}, {"inside": False}):
            with self.subTest(change=change):
                self.assertEqual(self.scan(person, [{**asset, **change}])["result"], "denied")
        legacy = {**person, "entryOverride": {"requestId": "legacy-review", "hardwareIds": ["h"]}}
        self.assertEqual(self.scan(legacy, [asset])["result"], "denied")

    def test_carried_hardware_zone_validity_and_presence_are_checked(self):
        person = {**self.person, "inside": False, "type": "employee", "status": "active", "validTo": "", "allowedZones": ["Office"], "entryOverride": None}
        asset = {"id": "h", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active", "inside": False, "allowedZones": ["Office"]}
        self.assertEqual(self.scan(person, [asset])["result"], "approved")
        for change in ({"assignedEmployeeId": "new-owner"}, {"status": "maintenance"}, {"inside": False}):
            with self.subTest(change=change):
                self.assertEqual(self.scan(person, [{**asset, **change}])["result"], "denied")
        legacy = {**person, "entryOverride": {"requestId": "legacy-review", "hardwareIds": ["h"]}}
        self.assertEqual(self.scan(legacy, [asset])["result"], "denied")

    def test_carried_hardware_zone_validity_and_presence_are_checked(self):
        person = {**self.person, "inside": False, "type": "employee", "status": "active", "validTo": "", "allowedZones": ["public"], "entryOverride": None}
        asset = {"id": "h", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active", "inside": False, "allowedZones": ["public"]}
        self.assertEqual(self.scan(person, [asset])["result"], "approved")
        for patch in ({"allowedZones": ["secure"]}, {"inside": True}, {"validTo": self.person["validTo"]}, {"status": "maintenance"}):
            with self.subTest(patch=patch):
                self.assertEqual(self.scan(person, [{**asset, **patch}])["result"], "denied")

    def test_employee_permission_states_fail_closed(self):
        for status in ("pending_approval", "expired", "inactive", "restricted"):
            person = {**self.person, "inside": False, "type": "employee", "status": status, "validTo": "", "allowedZones": ["public"], "entryOverride": None}
            self.assertEqual(self.scan(person)["result"], "denied")

    def test_access_windows_and_zones_reject_invalid_input(self):
        self.assertEqual(validate_zones([" a ", "b"]), ["a", "b"])
        validate_window("2026-09-17T12:00", "2026-09-17T07:00Z")
        for start, end in (("nonsense", ""), ("2026-09-18T00:00Z", "2026-09-17T00:00Z")):
            with self.assertRaises(HTTPException):
                validate_window(start, end)
        with self.assertRaises(HTTPException):
            validate_zones([42])

    def test_entry_validity_end_is_exclusive_but_existing_exit_remains_allowed(self):
        now = datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
        person = {"id": "p", "name": "Alice", "type": "employee", "barcode": "p", "inside": False,
            "status": "active", "allowedZones": ["a"], "validTo": now.isoformat()}
        checkpoint = {"id": "a-1", "zone": "a"}
        self.assertEqual(_status_for(person, checkpoint, "entry", [], now)["result"], "denied")
        self.assertEqual(_status_for({**person, "inside": True}, checkpoint, "exit", [], now)["result"], "approved")
