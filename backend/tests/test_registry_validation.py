"""Shared registry validation retains the same write-boundary behavior."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from registry_validation import is_barcode_conflict, validated_metadata
from schemas import SubjectCreate


class RegistryValidationTests(unittest.TestCase):
    def test_visitor_normalization_preserves_input_and_removes_server_owned_fields(self):
        incoming = {
            "name": " Visitor ", "host": " Host ", "phone": "private",
            "entryRestriction": {"active": False}, "accessRevision": 999,
            "validFrom": " 2026-10-19T09:00:00Z ", "custom": {"value": "kept"},
        }
        original = copy.deepcopy(incoming)
        actual = validated_metadata(SubjectCreate(kind="visitor", barcode="visitor-1", data=incoming))
        self.assertEqual(actual, {
            "name": "Visitor", "host": "Host", "validFrom": "2026-10-19T09:00:00Z",
            "custom": {"value": "kept"},
        })
        self.assertEqual(incoming, original)

    def test_both_registry_and_grant_inputs_reject_invalid_required_metadata(self):
        for data in ({"host": "Host"}, {"name": "Visitor"}, {"name": "Visitor", "host": " "},
                     {"name": "Visitor", "host": 7}, {"name": "Visitor", "host": "x" * 101}):
            with self.subTest(data=data), self.assertRaises(HTTPException) as caught:
                validated_metadata(SubjectCreate(kind="visitor", barcode="visitor-1", data=data))
            self.assertEqual(caught.exception.status_code, 422)

    def test_only_barcode_integrity_conflicts_are_recognized(self):
        for text, expected in (("duplicate key violates subjects_barcode_key", True),
                               ("UNIQUE constraint failed: subjects.barcode", True),
                               ("duplicate key violates permission_subject_key", False)):
            with self.subTest(text=text):
                error = IntegrityError("INSERT", {}, RuntimeError(text))
                self.assertEqual(is_barcode_conflict(error), expected)


if __name__ == "__main__":
    unittest.main()
