"""Transactional cross-building alerts against the isolated PostgreSQL fixture."""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import func, select

import test_database as fixture
from auth import verify_admin_request, verify_terminal_access_request
from models import (
    Alert, AlertRule, AlertRuleAssignment, CriticalAlertTrigger,
    CriticalEntryRestriction, Movement, PermissionRequestModel, Person, PresenceState, ScanRequest,
    Subject, TerminalCheckpointAssignment, EventOutbox,
)
from permission_decisions import apply_permission_decision
from schemas import BrowserScanPayload
from terminal_scans import record_scan


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class CrossBuildingAlertTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def _presence(self, subject_id="p1", *, state="inside", building="main-building"):
        timestamp = datetime.now(timezone.utc) - timedelta(minutes=15)
        override = {"requestId": "previous-admission", "hardwareIds": []}
        async with self.sessions() as db:
            row = await db.get(PresenceState, subject_id)
            if row is None:
                row = PresenceState(subject_id=subject_id)
                db.add(row)
            row.state = state
            row.entry_building_id = building
            row.last_scan_timestamp = timestamp
            row.entry_override = override if state == "inside" else None
            row.entry_started_at = timestamp if state == "inside" else None
            row.visitor_overstay_alerted_entry_at = timestamp if state == "inside" else None
            await db.commit()
        return timestamp, override

    async def _record(self, *, barcode="p1", checkpoint="server-room", direction=None,
                      hardware_ids=None, key=None, commit=True):
        body = {"barcode": barcode, "checkpointId": checkpoint,
                "selectedHardwareIds": hardware_ids or []}
        if direction:
            body["direction"] = direction
        async with self.sessions() as db:
            result = await record_scan(db, key or uuid.uuid4(),
                BrowserScanPayload.model_validate(body), "browser:test-operator")
            published = list(db.info["scan_alerts"])
            if commit:
                await db.commit()
            else:
                await db.rollback()
        return result, published

    async def test_employee_and_visitor_entry_and_exit_link_one_noncritical_alert_to_denial(self):
        async with self.sessions() as db:
            db.add(Subject(id="visitor", kind="visitor", barcode="visitor",
                person=Person(data={"name": "Visitor", "status": "pre_approved",
                                   "allowedZones": ["public", "secure"], "inside": False})))
            # Both rules are global presence checks, including people whose
            # individually selectable attendance rules have been disabled.
            db.add(AlertRuleAssignment(subject_id="p1", rule_ids=[], revision=1, updated_by="test-admin"))
            await db.commit()
        for subject_id, kind in (("p1", "employee"), ("visitor", "visitor")):
            for direction in ("entry", "exit"):
                with self.subTest(kind=kind, direction=direction):
                    timestamp, override = await self._presence(subject_id)
                    result, emitted = await self._record(barcode=subject_id, direction=direction)
                    event = result["decision"]["event"]
                    self.assertFalse(result["allowed"])
                    self.assertEqual(event["denialCode"], "cross_building_access")
                    self.assertEqual(len(emitted), 1)
                    alert_data = emitted[0]
                    self.assertEqual((alert_data["ruleId"], alert_data["conditionKey"]),
                        ("rule-cross-building-scan", "cross_building_scan"))
                    self.assertEqual((alert_data["subjectId"], alert_data["subjectType"]), (subject_id, kind))
                    self.assertEqual((alert_data["severity"], alert_data["category"]), ("high", "presence_anomaly"))
                    self.assertEqual(alert_data["sourceEventId"], event["id"])
                    async with self.sessions() as db:
                        alert = await db.scalar(select(Alert).where(Alert.source_event_id == event["id"]))
                        self.assertEqual(alert.data, alert_data)
                        presence = await db.get(PresenceState, subject_id)
                        self.assertEqual((presence.state, presence.entry_building_id), ("inside", "main-building"))
                        self.assertEqual(presence.last_scan_timestamp, timestamp)
                        self.assertEqual(presence.entry_override, override)
                        self.assertEqual(presence.entry_started_at, timestamp)
                        self.assertEqual(presence.visitor_overstay_alerted_entry_at, timestamp)
                        self.assertFalse((await db.get(Person, subject_id)).data["inside"])
                        self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalEntryRestriction)), 0)
                        self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalAlertTrigger)), 0)

    async def test_other_direction_and_building_are_detected_from_locked_presence(self):
        await self._presence(building="server-room-building")
        result, emitted = await self._record(checkpoint="cp-main")
        self.assertEqual(result["decision"]["event"]["denialCode"], "cross_building_access")
        self.assertEqual(len(emitted), 1)
        self.assertIn("Server Room", emitted[0]["reason"])
        self.assertIn("Main Entrance", emitted[0]["reason"])

    async def test_matching_building_outside_and_unknown_entry_building_do_not_raise_alert(self):
        for state, building in (("inside", "server-room-building"), ("outside", None), ("inside", None)):
            with self.subTest(state=state, building=building):
                await self._presence(state=state, building=building)
                _, emitted = await self._record()
                self.assertEqual(emitted, [])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)

    async def test_hardware_conflicts_and_unknown_barcodes_do_not_raise_person_alerts(self):
        await self._presence("h1")
        for barcode, hardware_ids in (("h1", []), ("unregistered", ["h1"]), ("p1", ["h1"])):
            with self.subTest(barcode=barcode):
                result, emitted = await self._record(barcode=barcode, hardware_ids=hardware_ids)
                self.assertFalse(result["allowed"])
                self.assertEqual(emitted, [])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)
            self.assertEqual((await db.get(PresenceState, "h1")).entry_building_id, "main-building")
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")

    async def test_person_and_carried_hardware_conflicts_raise_only_primary_person_alert(self):
        await self._presence("p1")
        await self._presence("h1")
        result, emitted = await self._record(hardware_ids=["h1"])
        self.assertFalse(result["allowed"])
        self.assertEqual([alert["subjectId"] for alert in emitted], ["p1"])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 1)
            self.assertEqual((await db.get(PresenceState, "h1")).state, "inside")

    async def test_stored_disabled_condition_overrides_legacy_default_without_allowing_scan(self):
        await self._presence()
        async with self.sessions() as db:
            db.add(AlertRule(id="configured-cross-building", data={
                "id": "configured-cross-building", "conditionKey": "cross_building_scan",
                "enabled": False, "severity": "high", "category": "presence_anomaly"}))
            await db.commit()
        result, emitted = await self._record()
        self.assertEqual(result["decision"]["event"]["denialCode"], "cross_building_access")
        self.assertEqual(emitted, [])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")

    async def test_malformed_saved_policies_cannot_crash_scan_or_override_displayed_default(self):
        await self._presence()
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        async with self.sessions() as db:
            disabled_policy = {"conditionKey": "cross_building_scan", "enabled": False}
            db.add_all([
                AlertRule(id="array-condition", data={"conditionKey": ["cross_building_scan"], "enabled": False}),
                AlertRule(id="object-condition", data={"conditionKey": {"legacy": "cross_building_scan"}, "enabled": False}),
                AlertRule(id="__proto__", data={**disabled_policy, "id": "rule-cross-building-scan"}),
                AlertRule(id="invalid.rule", data={**disabled_policy, "id": "rule-cross-building-scan"}),
            ])
            await db.commit()
        policies = await self.client.get("/v1/alerts")
        self.assertEqual(policies.status_code, 200, policies.text)
        cross_building_rules = [rule for rule in policies.json()["rules"]
            if rule["conditionKey"] == "cross_building_scan"]
        self.assertEqual([rule["id"] for rule in cross_building_rules], ["rule-cross-building-scan"])
        self.assertTrue(cross_building_rules[0]["enabled"])
        result, emitted = await self._record()
        self.assertFalse(result["allowed"])
        self.assertEqual([alert["ruleId"] for alert in emitted], [cross_building_rules[0]["id"]])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ScanRequest)), 1)

    async def test_idempotency_retry_publishes_alert_only_after_first_commit(self):
        await self._presence()
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        async with self.sessions() as db:
            assignment = await db.get(TerminalCheckpointAssignment, "browser:test-operator")
            assignment.checkpoint_id = "server-room"
            await db.commit()
        key = str(uuid.uuid4())
        body = {"barcode": "p1", "checkpointId": "server-room"}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()) as publish:
            first = await self.client.post("/v1/terminal/scans", json=body, headers={"Idempotency-Key": key})
            retry = await self.client.post("/v1/terminal/scans", json=body, headers={"Idempotency-Key": key})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), fixture.replay_receipt(first.json()))
        publish.assert_not_awaited()
        async with self.sessions() as db:
            events = (await db.scalars(select(EventOutbox).where(EventOutbox.kind == "presence"))).all()
            self.assertEqual(len(events), 1)
            self.assertIsNone(events[0].delivered_at)
            update = events[0].payload
        self.assertIsNone(update["state"])
        self.assertEqual(len(update["alerts"]), 1)
        self.assertEqual(update["alerts"][0]["sourceEventId"], first.json()["decision"]["event"]["id"])
        async with self.sessions() as db:
            for model in (Movement, ScanRequest, Alert):
                self.assertEqual(await db.scalar(select(func.count()).select_from(model)), 1)

    async def test_concurrent_same_key_retries_and_distinct_scans_remain_event_scoped(self):
        await self._presence()
        key = uuid.uuid4()
        retries = await asyncio.gather(self._record(key=key), self._record(key=key))
        self.assertEqual(sum(len(emitted) for _, emitted in retries), 1)
        self.assertEqual(sum(result["replayed"] for result, _ in retries), 1)
        distinct = await asyncio.gather(self._record(), self._record())
        self.assertEqual([len(emitted) for _, emitted in distinct], [1, 1])
        async with self.sessions() as db:
            for model in (Movement, ScanRequest, Alert):
                self.assertEqual(await db.scalar(select(func.count()).select_from(model)), 3)
            alerts = (await db.scalars(select(Alert))).all()
            self.assertEqual(len({alert.source_event_id for alert in alerts}), 3)

    async def test_scan_rollback_removes_movement_receipt_and_alert(self):
        timestamp, override = await self._presence()
        result, emitted = await self._record(commit=False)
        self.assertFalse(result["allowed"])
        self.assertEqual(len(emitted), 1)
        async with self.sessions() as db:
            for model in (Movement, ScanRequest, Alert):
                self.assertEqual(await db.scalar(select(func.count()).select_from(model)), 0)
            presence = await db.get(PresenceState, "p1")
            self.assertEqual((presence.state, presence.entry_building_id), ("inside", "main-building"))
            self.assertEqual(presence.last_scan_timestamp, timestamp)
            self.assertEqual(presence.entry_override, override)
            self.assertEqual(presence.entry_started_at, timestamp)
            self.assertEqual(presence.visitor_overstay_alerted_entry_at, timestamp)

    async def test_redundant_manually_approved_visitor_entry_preserves_visit_clock_and_alert_marker(self):
        now = datetime.now(timezone.utc)
        entry_started = now - timedelta(hours=13)
        source_id = str(uuid.uuid4())
        async with self.sessions() as db:
            db.add(Subject(id="visitor", kind="visitor", barcode="visitor",
                person=Person(data={"name": "Visitor", "status": "pre_approved",
                    "allowedZones": ["public", "secure"], "inside": True})))
            await db.flush()
            db.add(PresenceState(subject_id="visitor", state="inside", entry_building_id="main-building",
                last_scan_timestamp=now - timedelta(minutes=15), entry_started_at=entry_started,
                visitor_overstay_alerted_entry_at=entry_started))
            db.add(Movement(id=source_id, subject_id="visitor", checkpoint_id="cp-main",
                occurred_at=now - timedelta(minutes=2), result="denied", direction="entry",
                denial_code="already_inside", scan_type="auto", subject_type="visitor",
                sync_state="synced", data={"id": source_id, "barcode": "visitor", "hardwareIds": []}))
            db.add(PermissionRequestModel(id="redundant-entry-approval", subject_id="visitor",
                created_at=now, data={"type": "manual_override", "status": "pending", "barcode": "visitor",
                    "checkpointId": "cp-main", "direction": "entry", "eventId": source_id,
                    "subjectId": "visitor", "subjectName": "Visitor"}))
            # Use the actual authority path so the grant carries the reviewed
            # access snapshot required before a terminal can consume it.
            await db.flush()
            await apply_permission_decision(db, "redundant-entry-approval", "approved", "test-admin",
                "Reviewed redundant visitor entry", valid_for_minutes=30)
            await db.commit()
        result, emitted = await self._record(barcode="visitor", checkpoint="cp-main", direction="entry")
        self.assertTrue(result["allowed"])
        self.assertEqual(result["decision"]["event"]["manualApprovalRequestId"], "redundant-entry-approval")
        self.assertEqual(emitted, [])
        async with self.sessions() as db:
            presence = await db.get(PresenceState, "visitor")
            self.assertEqual(presence.entry_started_at, entry_started)
            self.assertEqual(presence.visitor_overstay_alerted_entry_at, entry_started)
            self.assertGreater(presence.last_scan_timestamp, now - timedelta(minutes=1))

    async def test_new_visitor_visit_initializes_clock_and_exit_clears_clock_and_marker(self):
        previous_entry = datetime.now(timezone.utc) - timedelta(days=1)
        async with self.sessions() as db:
            db.add(Subject(id="visitor", kind="visitor", barcode="visitor",
                person=Person(data={"name": "Visitor", "status": "pre_approved",
                    "allowedZones": ["public", "secure"], "inside": False})))
            await db.flush()
            db.add(PresenceState(subject_id="visitor", state="outside",
                visitor_overstay_alerted_entry_at=previous_entry))
            await db.commit()
        entered, _ = await self._record(barcode="visitor", checkpoint="cp-main", direction="entry")
        self.assertTrue(entered["allowed"])
        async with self.sessions() as db:
            presence = await db.get(PresenceState, "visitor")
            self.assertEqual(presence.entry_started_at, presence.last_scan_timestamp)
            self.assertIsNone(presence.visitor_overstay_alerted_entry_at)
            presence.visitor_overstay_alerted_entry_at = presence.entry_started_at
            presence.last_scan_timestamp -= timedelta(seconds=11)
            await db.commit()
        exited, _ = await self._record(barcode="visitor", checkpoint="cp-main", direction="exit")
        self.assertTrue(exited["allowed"])
        async with self.sessions() as db:
            presence = await db.get(PresenceState, "visitor")
            self.assertEqual(presence.state, "outside")
            self.assertIsNone(presence.entry_started_at)
            self.assertIsNone(presence.visitor_overstay_alerted_entry_at)


if __name__ == "__main__":
    unittest.main()
