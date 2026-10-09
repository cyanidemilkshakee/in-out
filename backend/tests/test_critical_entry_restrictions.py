"""Critical holds use actual PostgreSQL transactions and routed scan/release calls."""
import asyncio
import os
import sys
import uuid
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import select, func
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from pydantic import ValidationError

import test_database as database_fixture
from auth import verify_admin_request, verify_terminal_access_request
from models import (Alert, AlertRule, CriticalEntryRestriction, CriticalAlertTrigger,
    Subject, Person, HardwareAsset, PresenceState, AccessPermission, Movement, AuditEvent, ScanRequest)
from critical_entry_restrictions import activate_critical_entry_restrictions, entry_restrictions_for_subjects
from permission_decisions import apply_permission_decision
from schemas import BrowserScanPayload
from terminal_scans import record_scan
from routers.alerts import EntryRestrictionRelease


class EntryRestrictionReleaseValidationTests(unittest.TestCase):
    def test_release_requires_explicit_nonblank_reason_and_rejects_extra_fields(self):
        self.assertEqual(EntryRestrictionRelease(reason=" Checked ID ").reason, "Checked ID")
        for body in ({}, {"reason": " "}, {"reason": True}, {"reason": "x" * 1001},
                     {"reason": "Checked", "active": False}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                EntryRestrictionRelease.model_validate(body)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class CriticalEntryRestrictionDatabaseTests(unittest.IsolatedAsyncioTestCase):
    # Reuse only the isolated schema/ASGI fixture, not its collected test methods.
    asyncSetUp = database_fixture.DatabaseTests.asyncSetUp
    asyncTearDown = database_fixture.DatabaseTests.asyncTearDown
    _create_review = database_fixture.DatabaseTests._create_review

    async def trigger(self, *, alert_id=None, subject_id="p1", barcode=None, severity="critical", created_at=None, **extra):
        alert_id = alert_id or "AL-" + uuid.uuid4().hex
        data = {"id": alert_id, "severity": severity, "status": "open", "title": "Critical test alert", **extra}
        if subject_id is not None:
            data["subjectId"] = subject_id
        if barcode is not None:
            data["barcode"] = barcode
        async with self.sessions() as db:
            alert = Alert(id=alert_id, created_at=created_at or datetime.now(timezone.utc), data=data)
            db.add(alert)
            await activate_critical_entry_restrictions(db, [alert])
            await db.commit()
        return alert_id

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}

    async def scan(self, body=None, *, key=None):
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            return await self.client.post("/v1/terminal/scans", json=body or {"barcode": "p1", "checkpointId": "cp-main"},
                headers={"Idempotency-Key": str(key or uuid.uuid4())})

    async def release(self, alert_id, reason="Reviewed critical alert and verified entry may resume."):
        with patch("routers.alerts.publish_data_changed", new=AsyncMock()):
            return await self.client.post(f"/v1/alerts/{alert_id}/release-entry-restriction", json={"reason": reason})

    async def test_acknowledgement_keeps_hold_and_manual_pass_waits_for_explicit_release(self):
        self.authorize()
        alert_id = await self.trigger()
        denied = await self.scan()
        self.assertEqual(denied.status_code, 200, denied.text)
        self.assertFalse(denied.json()["allowed"])
        self.assertEqual(denied.json()["decision"]["entryRestrictions"][0]["subjectId"], "p1")
        with patch("routers.alerts.publish_presence_update", new=AsyncMock()):
            acknowledged = await self.client.patch(f"/v1/alerts/{alert_id}", json={"status": "acknowledged"})
        self.assertEqual(acknowledged.status_code, 200, acknowledged.text)
        self.assertTrue(acknowledged.json()["entryRestriction"]["active"])
        self.assertFalse((await self.scan()).json()["allowed"])
        async with self.sessions() as db:
            req_id = await self._create_review(db, "p1", "p1", denied.json()["decision"]["event"])
            approved = await apply_permission_decision(db, req_id, "approved", "test-admin", "Reviewed this entry only")
            await db.commit()
            self.assertIsNone(approved["movement"])
            self.assertTrue(approved["person"]["entryRestriction"]["active"])
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
        blocked = await self.scan()
        self.assertFalse(blocked.json()["allowed"], blocked.text)
        self.assertTrue(blocked.json()["decision"]["entryRestrictions"])
        released = await self.release(alert_id)
        self.assertEqual(released.status_code, 200, released.text)
        self.assertFalse(released.json()["entryRestriction"]["active"])
        admitted = await self.scan()
        self.assertTrue(admitted.json()["allowed"], admitted.text)
        self.assertEqual(admitted.json()["decision"]["event"]["direction"], "entry")
        exited = await self.scan()
        self.assertTrue(exited.json()["allowed"], exited.text)
        self.assertEqual(exited.json()["decision"]["event"]["direction"], "exit")
        self.assertFalse((await self.scan()).json()["allowed"])
        async with self.sessions() as db:
            state = await db.get(PresenceState, "p1")
            before = (state.state, state.last_scan_timestamp, state.entry_override)
        async with self.sessions() as db:
            state = await db.get(PresenceState, "p1")
            self.assertEqual((state.state, state.last_scan_timestamp, state.entry_override), before)
            self.assertEqual((await db.get(Alert, alert_id)).data["status"], "acknowledged")
            self.assertEqual((await db.get(CriticalEntryRestriction, "p1")).released_by, "test-admin")
        # Normal permission and cooldown policies still apply after release.
        after_cooldown = datetime.now(timezone.utc) + timedelta(seconds=11)
        with patch("terminal_scans.datetime", wraps=datetime) as clock:
            clock.now.return_value = after_cooldown
            admitted = await self.scan()
        self.assertTrue(admitted.json()["allowed"], admitted.text)

    async def test_release_is_admin_only_validated_idempotent_and_stale_safe(self):
        alert_id = await self.trigger()
        url = f"/v1/alerts/{alert_id}/release-entry-restriction"
        self.assertEqual((await self.client.post(url, json={"reason": "Checked"})).status_code, 401)
        with patch("auth.verify_authenticated_request", new=AsyncMock(return_value={
                "sub": "operator", "realm_access": {"roles": ["operator"]}})):
            self.assertEqual((await self.client.post(url, json={"reason": "Checked"})).status_code, 403)
        self.authorize()
        self.assertEqual((await self.release("missing-alert")).status_code, 404)
        unbound = await self.trigger(subject_id=None, subjectName="Alice")
        self.assertEqual((await self.release(unbound)).status_code, 422)
        for payload in ({"reason": " "}, {"reason": False}, {"reason": "Checked", "active": False}):
            self.assertEqual((await self.client.post(url, json=payload)).status_code, 422)
        async with self.sessions() as db:
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
            before = await db.scalar(select(func.count()).select_from(AuditEvent))
        first = await self.release(alert_id)
        retry = await self.release(alert_id, "A retry must not rewrite release history")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(first.json()["entryRestriction"], retry.json()["entryRestriction"])
        self.assertNotIn("auditEvent", retry.json())
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), before + 1)
            old = await db.get(Alert, alert_id)
            await activate_critical_entry_restrictions(db, [old])
            await db.commit()
            self.assertFalse((await db.get(CriticalEntryRestriction, "p1")).active)
        # An unseen delayed alert older than the release is recorded but cannot
        # reactivate it. A newly triggered critical alert can.
        released_at = datetime.fromisoformat(first.json()["entryRestriction"]["releasedAt"])
        await self.trigger(created_at=released_at - timedelta(minutes=1))
        async with self.sessions() as db:
            self.assertFalse((await db.get(CriticalEntryRestriction, "p1")).active)
        newer = await self.trigger(created_at=released_at + timedelta(seconds=1))
        stale = await self.release(alert_id)
        self.assertEqual(stale.status_code, 409, stale.text)
        async with self.sessions() as db:
            row = await db.get(CriticalEntryRestriction, "p1")
            self.assertTrue(row.active)
            self.assertEqual(row.trigger_alert_id, newer)
            self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalEntryRestriction)), 1)

    async def test_carried_hardware_hold_blocks_reviewed_entry_until_release(self):
        self.authorize()
        alert_id = await self.trigger(subject_id="h1")
        body = {"barcode": "p1", "checkpointId": "cp-main", "selectedHardwareIds": ["h1"]}
        denied = await self.scan(body)
        self.assertFalse(denied.json()["allowed"], denied.text)
        self.assertEqual(denied.json()["decision"]["event"]["denialCode"], "hardware_restricted")
        self.assertEqual(denied.json()["decision"]["entryRestrictions"][0]["subjectId"], "h1")
        self.assertFalse((await self.scan({"barcode": "h1", "checkpointId": "cp-main"})).json()["allowed"])
        async with self.sessions() as db:
            req_id = await self._create_review(db, "p1", "p1", denied.json()["decision"]["event"])
            await apply_permission_decision(db, req_id, "approved", "test-admin", "Reviewed person and carried laptop")
            await db.commit()
        still_held = await self.scan(body)
        self.assertFalse(still_held.json()["allowed"], still_held.text)
        self.assertTrue(still_held.json()["decision"]["entryRestrictions"])
        released = await self.release(alert_id)
        self.assertEqual(released.status_code, 200, released.text)
        entered = await self.scan(body)
        self.assertTrue(entered.json()["allowed"], entered.text)
        self.assertEqual(entered.json()["decision"]["event"]["direction"], "entry")
        exited = await self.scan(body)
        self.assertTrue(exited.json()["allowed"], exited.text)
        self.assertEqual(exited.json()["decision"]["event"]["direction"], "exit")
        self.assertFalse((await self.scan(body)).json()["allowed"])
        async with self.sessions() as db:
            self.assertFalse((await db.get(CriticalEntryRestriction, "h1")).active)
            self.assertIsNone(await db.get(CriticalEntryRestriction, "p1"))
            states = [(await db.get(PresenceState, subject_id)).state for subject_id in ("p1", "h1")]
            self.assertEqual(states, ["outside", "outside"])

    async def test_prior_success_replay_is_blocked_after_hold_without_duplicating_movement(self):
        self.authorize()
        key = uuid.uuid4()
        body = {"barcode": "p1", "checkpointId": "cp-main", "direction": "entry", "selectedHardwareIds": ["h1"]}
        admitted = await self.scan(body, key=key)
        self.assertTrue(admitted.json()["allowed"], admitted.text)
        await self.trigger(subject_id="h1")
        replay = await self.scan(body, key=key)
        self.assertEqual(replay.status_code, 403, replay.text)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ScanRequest)), 1)
            self.assertEqual((await db.get(ScanRequest, key)).response_body, admitted.json())
            self.assertEqual((await db.get(PresenceState, "p1")).state, "inside")
        exit_key = uuid.uuid4()
        exit_body = {**body, "direction": "exit"}
        exited = await self.scan(exit_body, key=exit_key)
        self.assertTrue(exited.json()["allowed"], exited.text)
        self.assertEqual((await self.scan(exit_body, key=exit_key)).json(), exited.json())

    async def test_offline_capture_is_checked_against_current_server_owned_hold(self):
        self.authorize()
        await self.trigger()
        captured = datetime.now(timezone.utc) - timedelta(days=3)
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "entryRestriction": {"active": False}}
            db.add(AccessPermission(id="normal-active-permission", subject_id="p1", data={
                "id": "normal-active-permission", "subjectId": "p1", "state": "active", "zones": ["public"]}))
            await db.commit()
        response = await self.scan({"barcode": "p1", "checkpointId": "cp-main", "online": False,
            "capturedOfflineAt": captured.isoformat()})
        self.assertFalse(response.json()["allowed"], response.text)
        event = response.json()["decision"]["event"]
        self.assertEqual(datetime.fromisoformat(event["capturedOfflineAt"]), captured)
        self.assertGreater(datetime.fromisoformat(event["createdAt"].replace("Z", "+00:00")), captured)
        self.assertTrue(response.json()["updatedPeople"][0]["entryRestriction"]["active"])
        async with self.sessions() as db:
            self.assertEqual((await db.get(PresenceState, "p1")).state, "outside")
            self.assertEqual((await db.get(AccessPermission, "normal-active-permission")).data["state"], "active")
        bundle = (await self.client.get("/v1/registry/bundle")).json()
        self.assertTrue(next(person for person in bundle["people"] if person["id"] == "p1")["entryRestriction"]["active"])

    async def test_binding_never_uses_names_or_falls_back_from_invalid_identity(self):
        await self.trigger(subject_id=None, subjectName="Alice")
        await self.trigger(subject_id="deleted-subject", barcode="p1", subjectName="Alice")
        await self.trigger(subject_id=" ", barcode="p1")
        await self.trigger(subject_id="p1", severity="medium")
        await self.trigger(subject_id="p1", severity="high")
        missing_id = await self.trigger(subject_id=None, barcode="new-barcode")
        async with self.sessions() as db:
            self.assertEqual(await entry_restrictions_for_subjects(db, ["p1"]), {})
            db.add(Subject(id="p-new", kind="employee", barcode="new-barcode", person=Person(data={"name": "Alice", "status": "active"})))
            await db.commit()
            old = await db.get(Alert, missing_id)
            await activate_critical_entry_restrictions(db, [old])
            await db.commit()
            self.assertIsNone(await db.get(CriticalEntryRestriction, "p-new"))
        alert_id = await self.trigger(subject_id=None, barcode=" P1 ")
        async with self.sessions() as db:
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
            self.assertEqual((await db.get(Alert, alert_id)).data["subjectId"], "p1")

    async def test_unmanaged_subject_directories_expose_server_owned_hardware_hold(self):
        self.authorize()
        await self.trigger(subject_id="h1")
        registry = (await self.client.get("/v1/registry/bundle")).json()
        terminal = (await self.client.get("/v1/terminal/bundle")).json()
        permissions = (await self.client.get("/v1/permissions")).json()
        for assets, id_field in ((registry["hardwareAssets"], "id"), (terminal["hardwareAssets"], "id"),
                                 (permissions["subjects"], "id")):
            asset = next(item for item in assets if item[id_field] == "h1")
            self.assertTrue(asset["entryRestriction"]["active"])

    async def test_backfill_binds_acknowledged_critical_alerts_and_keeps_unbound_evidence(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            db.add_all([
                Alert(id="legacy-id", created_at=now - timedelta(days=1), data={"severity": "critical", "status": "acknowledged", "subjectId": "p1"}),
                Alert(id="legacy-barcode", created_at=now, data={"severity": "critical", "barcode": "H1"}),
                Alert(id="legacy-name", created_at=now, data={"severity": "critical", "subjectName": "Alice"}),
                Alert(id="legacy-wrong-id", created_at=now, data={"severity": "critical", "subjectId": "missing", "barcode": "p1"}),
                Alert(id="medium", created_at=now, data={"severity": "medium", "subjectId": "p1"}),
            ])
            await db.commit()
        async with self.engine.begin() as conn:
            def rerun(connection):
                revision = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic")).get_revision("s7t8u9v0w1").module
                with Operations.context(MigrationContext.configure(connection)):
                    revision.downgrade()
                    revision.upgrade()
            await conn.run_sync(rerun)
        async with self.sessions() as db:
            states = await entry_restrictions_for_subjects(db, ["p1", "h1"])
            self.assertEqual(set(states), {"p1", "h1"})
            self.assertTrue(all(state["active"] for state in states.values()))
            self.assertEqual(states["p1"]["triggerAlertId"], "legacy-id")
            self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalAlertTrigger)), 4)
            self.assertIsNone((await db.get(CriticalAlertTrigger, "legacy-name")).subject_id)
            self.assertIsNone((await db.get(CriticalAlertTrigger, "legacy-wrong-id")).subject_id)
            self.assertEqual((await db.get(Alert, "legacy-barcode")).data["subjectId"], "h1")
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 2)

    async def test_alert_retention_does_not_release_or_prevent_explicit_release(self):
        self.authorize()
        alert_id = await self.trigger()
        async with self.sessions() as db:
            await db.delete(await db.get(Alert, alert_id))
            await db.commit()
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
        self.assertFalse((await self.scan()).json()["allowed"])
        released = await self.release(alert_id)
        self.assertEqual(released.status_code, 200, released.text)
        self.assertFalse(released.json()["entryRestriction"]["active"])

    async def test_registry_deletion_cannot_erase_critical_identity_binding(self):
        self.authorize()
        await self.trigger()
        deleted = await self.client.delete("/v1/registry/subjects/p1")
        self.assertEqual(deleted.status_code, 409, deleted.text)
        async with self.sessions() as db:
            self.assertIsNotNone(await db.get(Subject, "p1"))
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)

    async def test_scheduled_critical_alert_is_atomically_bound_and_evaluation_deduplicates(self):
        from workflows.activities import run_alert_rule_evaluation
        fixed_now = datetime(2026, 10, 6, 13, 0, tzinfo=timezone.utc)
        async with self.sessions() as db:
            rule = await db.get(AlertRule, "rule-irregularity")
            data = {"id": "rule-irregularity", "conditionKey": "irregularity", "enabled": True, "severity": "critical"}
            if rule:
                rule.data = data
            else:
                db.add(AlertRule(id="rule-irregularity", data=data))
            await db.commit()
        with patch("workflows.activities.async_session", new=self.sessions), \
             patch("workflows.activities.publish_presence_update", new=AsyncMock()), \
             patch("workflows.activities.datetime", wraps=datetime) as clock:
            clock.now.return_value = fixed_now
            self.assertEqual(await run_alert_rule_evaluation(), 1)
            self.assertEqual(await run_alert_rule_evaluation(), 0)
        async with self.sessions() as db:
            alert = await db.scalar(select(Alert))
            state = await db.get(CriticalEntryRestriction, "p1")
            self.assertTrue(state.active)
            self.assertEqual(state.trigger_alert_id, alert.id)
            self.assertEqual((alert.data["subjectId"], alert.data["barcode"]), ("p1", "p1"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(CriticalAlertTrigger)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)

    async def test_activation_rollback_preserves_alert_restriction_and_audit_atomicity(self):
        async with self.sessions() as db:
            alert = Alert(id="rolled-back", created_at=datetime.now(timezone.utc), data={"severity": "critical", "subjectId": "p1"})
            db.add(alert)
            await activate_critical_entry_restrictions(db, [alert])
            await db.rollback()
        async with self.sessions() as db:
            for model in (Alert, CriticalEntryRestriction, CriticalAlertTrigger, AuditEvent):
                self.assertEqual(await db.scalar(select(func.count()).select_from(model)), 0)

    async def test_concurrent_scan_waits_for_critical_activation_then_denies_entry(self):
        async with self.sessions() as activation_db:
            await activation_db.execute(select(Subject.id).where(Subject.id == "p1").with_for_update())
            alert = Alert(id="concurrent", created_at=datetime.now(timezone.utc), data={"severity": "critical", "subjectId": "p1"})
            activation_db.add(alert)
            await activate_critical_entry_restrictions(activation_db, [alert])
            async def scan():
                async with self.sessions() as scan_db:
                    result = await record_scan(scan_db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp-main"), "test")
                    await scan_db.commit()
                    return result
            task = asyncio.create_task(scan())
            try:
                done, _ = await asyncio.wait({task}, timeout=0.1)
                self.assertFalse(done)
                await activation_db.commit()
                result = await asyncio.wait_for(task, timeout=5)
                self.assertFalse(result["allowed"])
                self.assertEqual(result["decision"]["entryRestrictions"][0]["triggerAlertId"], "concurrent")
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
