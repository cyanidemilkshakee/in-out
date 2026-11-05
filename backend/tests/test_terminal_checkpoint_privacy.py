"""Terminal awareness never exposes another zone through checkpoint metadata."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers.terminal import _checkpoint_scope_allows


class TerminalCheckpointPrivacyTests(unittest.TestCase):
    def test_legacy_foreign_checkpoint_metadata_cannot_expose_a_subject(self):
        self.assertFalse(_checkpoint_scope_allows("b-1", "b", ["a"], ["b-1"]))

    def test_checkpoint_grants_narrow_a_shared_zone_grant(self):
        self.assertTrue(_checkpoint_scope_allows("a-1", "a", ["a", "b"], ["a-1"]))
        self.assertFalse(_checkpoint_scope_allows("a-2", "a", ["a", "b"], ["a-1"]))

    def test_explicit_empty_and_legacy_absent_checkpoint_lists_keep_zone_scope(self):
        for checkpoints in (None, []):
            with self.subTest(checkpoints=checkpoints):
                self.assertTrue(_checkpoint_scope_allows("a-1", "a", ["a"], checkpoints))
                self.assertFalse(_checkpoint_scope_allows("b-1", "b", ["a"], checkpoints))

    def test_missing_zone_and_malformed_scope_fail_closed(self):
        for zone, zones, checkpoints in ((None, ["a"], ["a-1"]),
                                         ("a", None, ["a-1"]),
                                         ("a", ["a"], "a-1")):
            with self.subTest(zone=zone, zones=zones, checkpoints=checkpoints):
                self.assertFalse(_checkpoint_scope_allows("a-1", zone, zones, checkpoints))
