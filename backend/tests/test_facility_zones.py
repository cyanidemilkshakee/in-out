"""Two-zone validation, legacy aliases, and exact retry compatibility."""
import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from access_validation import validate_checkpoint_id, validate_zones
from facility_zones import CHECKPOINTS, compatible_request_fingerprints, normalize_facility_document


class FacilityZoneTests(unittest.TestCase):
    def test_only_two_zones_and_checkpoints_can_be_written(self):
        self.assertEqual([item["id"] for item in CHECKPOINTS], ["cp-main", "server-room"])
        self.assertEqual(validate_zones([" Main Entrance ", "public", "Server Room"]), ["public", "secure"])
        self.assertEqual(validate_zones(["All Zones"]), ["public", "secure"])
        self.assertEqual(validate_checkpoint_id("main-gate"), "cp-main")
        for zone in ("IT Lab", "Warehouse", "Auditorium", "main-gate"):
            with self.subTest(zone=zone), self.assertRaises(HTTPException) as error:
                validate_zones([zone])
            self.assertEqual(error.exception.status_code, 422)
        with self.assertRaises(HTTPException):
            validate_checkpoint_id("cp-warehouse")

    def test_nested_snapshots_retain_evidence_and_normalize_typed_references(self):
        source = {"decision": {"event": {"id": "original", "checkpointId": "main-gate", "reason": "main-gate was closed"}},
                  "person": {"allowedZones": ["All Zones"]}, "previousZones": ["Old lab"],
                  "entry_override": {"checkpoint_id": "main-gate"}}
        normalized = normalize_facility_document(source)
        self.assertEqual(normalized["decision"]["event"]["checkpointId"], "cp-main")
        self.assertEqual(normalized["decision"]["event"]["id"], "original")
        self.assertEqual(normalized["decision"]["event"]["reason"], "main-gate was closed")
        self.assertEqual(normalized["person"]["allowedZones"], ["public", "secure"])
        self.assertEqual(normalized["previousZones"], ["Old lab"])
        self.assertEqual(source["decision"]["event"]["checkpointId"], "main-gate")
        self.assertEqual(normalize_facility_document(normalized), normalized)

    def test_alias_retry_hashes_match_old_payloads_without_accepting_other_changes(self):
        body = {"barcode": "employee", "checkpoint_id": "main-gate", "direction": "entry", "online": True}
        old_hash = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        hashes = compatible_request_fingerprints(body, ["checkpoint_id"])
        self.assertIn(old_hash, hashes)
        self.assertEqual(hashes, compatible_request_fingerprints({**body, "checkpoint_id": "cp-main"}, ["checkpoint_id"]))
        for changes in ({"barcode": "other"}, {"direction": "exit"}, {"online": False}, {"checkpoint_id": "server-room"}):
            self.assertNotIn(old_hash, compatible_request_fingerprints({**body, **changes}, ["checkpoint_id"]))
