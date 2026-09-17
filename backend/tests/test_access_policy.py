import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from movement_logic import evaluate_scan
from access_validation import validate_window, validate_zones
from fastapi import HTTPException


class AccessPolicyTests(unittest.TestCase):
    def setUp(self):
        self.person = {"id": "p", "name": "Visitor", "type": "visitor", "barcode": "v", "inside": True,
            "status": "pending_approval", "allowedZones": [],
            "validTo": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "entryOverride": {"requestId": "manual-entry", "hardwareIds": []}}

    def scan(self, subject, hardware=None):
        return evaluate_scan(barcode=subject["barcode"], checkpoint={"id": "cp", "zone": "Office", "mode": "auto"},
            people=[subject], hardware=hardware or [], selected_hardware_ids=[item["id"] for item in (hardware or [])],
            online=True, event_count=0, scan_type="auto")["event"]

    def test_manually_admitted_visitor_can_exit_after_permission_expiry(self):
        self.assertEqual(self.scan(self.person)["result"], "approved")
        self.assertEqual(self.scan({**self.person, "inside": False})["result"], "denied")

    def test_manual_exit_does_not_authorize_new_hardware(self):
        asset = {"id": "extra", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active", "inside": True, "allowedZones": ["Office"]}
        self.assertEqual(self.scan(self.person, [asset])["result"], "denied")

    def test_carried_hardware_zone_validity_and_presence_are_checked(self):
        person = {**self.person, "inside": False, "type": "employee", "status": "active", "validTo": "", "allowedZones": ["Office"], "entryOverride": None}
        asset = {"id": "h", "name": "Laptop", "barcode": "h", "category": "Laptop", "status": "active", "inside": False, "allowedZones": ["Office"]}
        self.assertEqual(self.scan(person, [asset])["result"], "approved")
        for patch in ({"allowedZones": ["Restricted lab"]}, {"inside": True}, {"validTo": self.person["validTo"]}, {"status": "maintenance"}):
            with self.subTest(patch=patch):
                self.assertEqual(self.scan(person, [{**asset, **patch}])["result"], "denied")

    def test_employee_permission_states_fail_closed(self):
        for status in ("pending_approval", "expired", "inactive", "restricted"):
            person = {**self.person, "inside": False, "type": "employee", "status": status, "validTo": "", "allowedZones": ["Office"], "entryOverride": None}
            self.assertEqual(self.scan(person)["result"], "denied")

    def test_access_windows_and_zones_reject_invalid_input(self):
        self.assertEqual(validate_zones([" Office ", "Office"]), ["Office"])
        validate_window("2026-09-17T12:00", "2026-09-17T07:00Z")
        for start, end in (("nonsense", ""), ("2026-09-18T00:00Z", "2026-09-17T00:00Z")):
            with self.assertRaises(HTTPException):
                validate_window(start, end)
        with self.assertRaises(HTTPException):
            validate_zones([42])
