"""Shared subjects cannot receive foreign-zone grants through global mutations."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from models import AccessPermission, HardwareAsset, Subject
from routers import alerts, permissions
from schemas import PermissionDecision, PermissionGrantCreate
from zone_access import require_subject_grant_scope


ACTOR = {"sub": "only-a", "realm_access": {"roles": ["zone-admin"]}}


class GlobalGrantScopeTests(unittest.IsolatedAsyncioTestCase):
    def session(self, zones, checkpoints=None, *, metadata_zones=None):
        subject = Subject(id="asset", barcode="ASSET", kind="hardware", hardware=HardwareAsset(data={
            "allowedZones": metadata_zones if metadata_zones is not None else zones}))
        data = {"zones": zones}
        if checkpoints is not None:
            data["checkpoints"] = checkpoints
        permission = AccessPermission(id="grant", subject_id="asset", data=data)
        db = SimpleNamespace(scalar=AsyncMock(side_effect=[subject, subject, permission]),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: ["a"])),
            get=AsyncMock(side_effect=lambda model, identity: SimpleNamespace(
                id=identity, active=True, zone_id=identity.split("-", 1)[0])))
        return db, subject

    async def test_overlap_does_not_authorize_a_global_grant(self):
        for checkpoints in (None, [], ["a-1", "b-1"]):
            with self.subTest(checkpoints=checkpoints):
                db, _ = self.session(["a", "b"], checkpoints)
                with self.assertRaises(HTTPException) as raised:
                    await require_subject_grant_scope(db, ACTOR, "asset")
                self.assertEqual(raised.exception.status_code, 403)

    async def test_canonical_permission_wins_over_stale_metadata(self):
        db, subject = self.session(["a"], metadata_zones=["b"])
        self.assertIs(await require_subject_grant_scope(db, ACTOR, "asset"), subject)
        self.assertIsNotNone(db.scalar.await_args_list[1].args[0]._for_update_arg)
        self.assertIsNotNone(db.scalar.await_args_list[2].args[0]._for_update_arg)

    async def test_checkpoint_restrictions_limit_the_effective_global_scope(self):
        db, subject = self.session(["a", "b"], ["a-1"])
        self.assertIs(await require_subject_grant_scope(db, ACTOR, "asset"), subject)

    async def test_master_admin_can_manage_shared_subjects(self):
        db, subject = self.session(["a", "b"])
        actor = {"sub": "master", "realm_access": {"roles": ["master-admin"]}}
        self.assertIs(await require_subject_grant_scope(db, actor, "asset"), subject)

    async def test_malformed_access_documents_fail_closed(self):
        for zones, checkpoints in (("a", None), (["a"], "a-1"), (["a"] * 101, None)):
            with self.subTest(zones=zones, checkpoints=checkpoints):
                db, _ = self.session(zones, checkpoints)
                with self.assertRaises(HTTPException) as raised:
                    await require_subject_grant_scope(db, ACTOR, "asset")
                self.assertEqual(raised.exception.status_code, 409)


class GlobalGrantRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_rule_assignment_keeps_policy_lock_before_global_subject_lock(self):
        events = []
        async def visible(*args):
            events.append("visible")
        async def policy(*args):
            events.append("policy_lock")
        async def global_scope(*args):
            events.append("subject_lock")
        async def replace(*args):
            events.append("replace")
            return {"subjectId": "asset"}, False
        db = SimpleNamespace(commit=AsyncMock())
        payload = SimpleNamespace(ruleIds=[], expectedRevision=None, irregularitySkipDates=[])
        with patch.object(alerts, "require_subject_scope", side_effect=visible), \
             patch.object(alerts, "lock_scheduled_alert_evaluation", side_effect=policy), \
             patch.object(alerts, "require_subject_grant_scope", side_effect=global_scope), \
             patch.object(alerts, "replace_alert_rule_assignment", side_effect=replace):
            await alerts.update_alert_rule_assignment("asset", payload, db, ACTOR)
        self.assertEqual(events, ["visible", "policy_lock", "subject_lock", "replace"])
        db.commit.assert_awaited_once()

    async def test_warning_reset_and_entry_release_stop_before_side_effects(self):
        for action in ("reset", "release"):
            with self.subTest(action=action):
                db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(subject_id="asset")),
                    commit=AsyncMock())
                with patch.object(alerts, "require_subject_grant_scope", side_effect=HTTPException(403, "foreign zone")), \
                     patch.object(alerts, "reset_subject_warnings", new=AsyncMock()) as reset, \
                     patch.object(alerts, "release_critical_entry_restriction", new=AsyncMock()) as release:
                    with self.assertRaises(HTTPException) as raised:
                        if action == "reset":
                            await alerts.reset_alert_warnings("asset", SimpleNamespace(reason="Verified"), db, ACTOR)
                        else:
                            await alerts.release_entry_restriction("alert", SimpleNamespace(reason="Verified"), db, ACTOR)
                    self.assertEqual(raised.exception.status_code, 403)
                    reset.assert_not_awaited()
                    release.assert_not_awaited()
                    db.commit.assert_not_awaited()

    async def test_hold_release_requires_every_affected_zone_unless_master_admin(self):
        for actor, zones, should_release in (
            (ACTOR, ("a",), False),
            (ACTOR, ("a", "b"), True),
            ({"sub": "master", "realm_access": {"roles": ["master-admin"]}}, ("a",), True),
        ):
            with self.subTest(actor=actor["sub"], zones=zones):
                marker = SimpleNamespace(subject_id="employee", zone_ids=["a", "b"])
                db = SimpleNamespace(get=AsyncMock(return_value=marker), commit=AsyncMock())
                with patch.object(alerts, "require_subject_grant_scope", new=AsyncMock()), \
                     patch.object(alerts, "admin_zone_ids", new=AsyncMock(return_value=zones)) as get_zones, \
                     patch.object(alerts, "release_critical_entry_restriction",
                         new=AsyncMock(return_value={"entryRestriction": {"active": False}})) as release, \
                     patch.object(alerts, "enqueue_changed", new=AsyncMock()):
                    if should_release:
                        await alerts.release_entry_restriction("alert", SimpleNamespace(reason="Reviewed"), db, actor)
                        release.assert_awaited_once()
                        db.commit.assert_awaited_once()
                    else:
                        with self.assertRaises(HTTPException) as raised:
                            await alerts.release_entry_restriction("alert", SimpleNamespace(reason="Reviewed"), db, actor)
                        self.assertEqual(raised.exception.status_code, 403)
                        release.assert_not_awaited()
                        db.commit.assert_not_awaited()
                    if actor["sub"] == "master":
                        get_zones.assert_not_awaited()

    async def test_direct_custody_grant_checks_global_scope_before_creating_permission(self):
        db = SimpleNamespace(commit=AsyncMock(), add=Mock())
        payload = PermissionGrantCreate(subject_id="asset", checkpoint_id="a-1",
            request_type="hardware_custody", carrier_id="employee")
        with patch.object(permissions, "admin_zone_ids", new=AsyncMock(return_value=("a",))), \
             patch.object(permissions, "require_registered_checkpoint", new=AsyncMock(return_value="a-1")), \
             patch.object(permissions, "require_checkpoint_scope", new=AsyncMock()), \
             patch.object(permissions, "require_subject_scope", new=AsyncMock()), \
             patch.object(permissions, "require_subject_grant_scope", side_effect=HTTPException(403, "foreign zone")), \
             patch("permission_grants.apply_direct_permission", new=AsyncMock()) as apply:
            with self.assertRaises(HTTPException) as raised:
                await permissions.grant_permission(payload, db, ACTOR)
            self.assertEqual(raised.exception.status_code, 403)
            apply.assert_not_awaited()
            db.add.assert_not_called()
            db.commit.assert_not_awaited()

    async def test_approved_custody_request_checks_global_scope_before_decision(self):
        record = SimpleNamespace(subject_id="asset", data={"type": "hardware_custody", "checkpointId": "a-1"})
        db = SimpleNamespace(scalar=AsyncMock(return_value=record), commit=AsyncMock())
        with patch.object(permissions, "require_checkpoint_scope", new=AsyncMock()), \
             patch.object(permissions, "require_subject_grant_scope", side_effect=HTTPException(403, "foreign zone")), \
             patch("permission_decisions.apply_permission_decision", new=AsyncMock()) as apply:
            with self.assertRaises(HTTPException) as raised:
                await permissions.decide_permission_request("request", PermissionDecision(decision="approved"), db, ACTOR)
            self.assertEqual(raised.exception.status_code, 403)
            apply.assert_not_awaited()
            db.commit.assert_not_awaited()
