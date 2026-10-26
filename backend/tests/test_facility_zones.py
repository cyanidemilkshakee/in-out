"""Two organization zones and dynamic numbered checkpoints."""
import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from access_validation import require_registered_checkpoint, validate_zones
from facility_zones import CHECKPOINTS, compatible_request_fingerprints, normalize_facility_document
from models import Checkpoint, OrganizationZone
from movement_logic import denial_code_for_reason


class FacilityZoneTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_zones_and_checkpoint_ids_are_a_b_and_numbered(self):
        self.assertEqual([item["id"] for item in CHECKPOINTS], ["a-1", "a-2", "b-1", "b-2"])
        self.assertEqual(validate_zones([" a ", "b"]), ["a", "b"])
        self.assertEqual(validate_zones(["All Zones"]), ["a", "b"])
        for zone in ("public", "secure", "Main Entrance", "unregistered"):
            with self.subTest(zone=zone), self.assertRaises(HTTPException) as error:
                validate_zones([zone])
            self.assertEqual(error.exception.status_code, 422)

        active_zone = OrganizationZone(id="a", name="A", active=True)
        registered = Checkpoint(id="a-3", zone_id="a", number=3, gate_type="custom",
            required=False, active=True, data={"name": "Warehouse Gate"})
        db = Mock(get=AsyncMock(side_effect=lambda model, identity:
            registered if model is Checkpoint and identity == "a-3" else None),
            scalar=AsyncMock(return_value=active_zone))
        self.assertEqual(await require_registered_checkpoint(db, "a-3"), "a-3")
        with self.assertRaises(HTTPException) as unknown:
            await require_registered_checkpoint(db, "a-4")
        self.assertEqual(unknown.exception.status_code, 422)
        with self.assertRaises(HTTPException):
            await require_registered_checkpoint(db, "../checkpoint")

        self.assertEqual(denial_code_for_reason("Asset not expected out"), "asset_not_expected_out")

    def test_nested_snapshots_preserve_evidence_and_normalize_zone_lists(self):
        source = {"decision": {"event": {"id": "original", "checkpointId": "a-1", "reason": "a-1 was closed"}},
                  "person": {"allowedZones": ["All Zones"]}, "previousZones": ["Old lab"],
                  "entry_override": {"checkpoint_id": "a-2"}}
        normalized = normalize_facility_document(source)
        self.assertEqual(normalized["decision"]["event"]["checkpointId"], "a-1")
        self.assertEqual(normalized["decision"]["event"]["id"], "original")
        self.assertEqual(normalized["decision"]["event"]["reason"], "a-1 was closed")
        self.assertEqual(normalized["person"]["allowedZones"], ["a", "b"])
        self.assertEqual(normalized["previousZones"], ["Old lab"])
        self.assertEqual(source["decision"]["event"]["checkpointId"], "a-1")
        self.assertEqual(normalize_facility_document(normalized), normalized)

    def test_retry_fingerprint_does_not_alias_old_checkpoint_ids(self):
        body = {"barcode": "employee", "checkpoint_id": "a-1", "direction": "entry", "online": True}
        expected = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        hashes = compatible_request_fingerprints(body, ["checkpoint_id"])
        self.assertIn(expected, hashes)
        self.assertEqual(hashes, compatible_request_fingerprints(body, ["checkpoint_id"]))
        legacy = {**body, "checkpoint_id": "cp-main"}
        legacy_hash = hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest()
        self.assertNotIn(legacy_hash, compatible_request_fingerprints(body, ["checkpoint_id"]))


if __name__ == "__main__":
    unittest.main()
