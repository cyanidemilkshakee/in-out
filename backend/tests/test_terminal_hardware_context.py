"""Terminal regressions using the isolated, migrated PostgreSQL fixture."""
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import test_database as database_tests
from auth import verify_admin_request, verify_terminal_access_request
from models import HardwareAsset, Movement, PermissionRequestModel, PresenceState, ScanRequest, TerminalCheckpointAssignment
from schemas import BrowserScanPayload
from terminal_scans import record_scan
from fastapi import HTTPException
from sqlalchemy import func, select


@unittest.skipUnless(database_tests.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class TerminalHardwareContextTests(unittest.IsolatedAsyncioTestCase):
    # Reuse only fixture setup, without inheriting/discovering its entire suite.
    asyncSetUp = database_tests.DatabaseTests.asyncSetUp
    asyncTearDown = database_tests.DatabaseTests.asyncTearDown

    async def test_terminal_bundle_exposes_current_retention_and_server_clock_including_indefinite(self):
        from routers import terminal
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        for days in (30, 0):
            before = datetime.now(timezone.utc)
            with patch.object(terminal.settings, "IDEMPOTENCY_RETENTION_DAYS", days):
                response = await self.client.get("/v1/terminal/bundle")
            self.assertEqual(response.status_code, 200, response.text)
            policy = response.json()["terminalReplayPolicy"]
            self.assertEqual(policy["receiptRetentionDays"], days)
            observed = datetime.fromisoformat(policy["serverTime"])
            self.assertGreaterEqual(observed, before)
            self.assertLessEqual(observed, datetime.now(timezone.utc))

    async def _scan(self, body, key=None):
        return await self.client.post("/v1/terminal/scans", json=body,
            headers={"Idempotency-Key": key or str(uuid.uuid4())})

    async def test_unknown_barcode_retains_hardware_for_exact_manual_approval_and_rescan(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "unknown-with-laptop", "checkpointId": "cp-main", "selectedHardwareIds": ["h1"]}
        temporal = SimpleNamespace(start_workflow=AsyncMock(),
            get_workflow_handle=lambda _: SimpleNamespace(signal=AsyncMock()))
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()), \
             patch("permission_decisions.publish_presence_update", new=AsyncMock()), \
             patch("routers.terminal.get_temporal_client", new=AsyncMock(return_value=temporal)), \
             patch("routers.permissions.get_temporal_client", new=AsyncMock(return_value=temporal)):
            key = str(uuid.uuid4())
            denied = await self._scan(body, key)
            self.assertEqual(denied.status_code, 200, denied.text)
            self.assertFalse(denied.json()["allowed"])
            event = denied.json()["decision"]["event"]
            self.assertEqual(event["hardwareIds"], ["h1"])
            self.assertEqual([asset["id"] for asset in denied.json()["decision"]["carriedHardware"]], ["h1"])
            replay = await self._scan(body, key)
            self.assertEqual(replay.json(), database_tests.replay_receipt(denied.json()))
            async with self.sessions() as db:
                self.assertEqual((await db.get(Movement, event["id"])).data["hardwareIds"], ["h1"])
                self.assertIsNone(await db.get(PresenceState, "h1"))
                self.assertFalse((await db.get(HardwareAsset, "h1")).data["inside"])
            review = await self.client.post("/v1/terminal/manual-reviews", json={
                "barcode": body["barcode"], "checkpointId": "cp-main", "direction": "entry",
                "eventId": event["id"], "operatorNote": "Visitor and laptop verified at the gate."})
            self.assertEqual(review.status_code, 200, review.text)
            request_id = review.json()["id"]
            approved = await self.client.post(f"/v1/permission-requests/{request_id}/decide",
                json={"decision": "approved", "reason": "Verified visitor and laptop", "valid_for_minutes": 60})
            self.assertEqual(approved.status_code, 200, approved.text)
            missing_asset = await self._scan({**body, "selectedHardwareIds": []})
            self.assertFalse(missing_asset.json()["allowed"], missing_asset.text)
            async with self.sessions() as db:
                self.assertFalse((await db.get(PermissionRequestModel, request_id)).data.get("consumedAt"))
            entered = await self._scan(body)
            self.assertEqual(entered.status_code, 200, entered.text)
            self.assertTrue(entered.json()["allowed"], entered.text)
            self.assertEqual(entered.json()["decision"]["event"]["manualApprovalRequestId"], request_id)
            self.assertEqual(entered.json()["decision"]["event"]["hardwareIds"], ["h1"])
            async with self.sessions() as db:
                self.assertEqual((await db.get(PresenceState, "h1")).state, "inside")
                self.assertEqual((await db.get(PresenceState, "h1")).entry_override["hardwareIds"], ["h1"])
                self.assertTrue((await db.get(HardwareAsset, "h1")).data["inside"])

    async def test_unknown_scan_rejects_nonexistent_and_person_hardware_ids(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        for hardware_id in ("missing-hardware", "p1"):
            response = await self._scan({"barcode": "unknown-invalid-asset", "checkpointId": "cp-main",
                "selectedHardwareIds": [hardware_id]})
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn("hardware is not registered", response.text)

    async def test_unknown_scan_deduplicates_hardware_and_preserves_existing_presence(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        async with self.sessions() as db:
            db.add(PresenceState(subject_id="h1", state="inside", entry_building_id="public"))
            await db.commit()
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            response = await self._scan({"barcode": "unknown-existing-presence", "checkpointId": "cp-main",
                "selectedHardwareIds": ["h1", "h1"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["decision"]["event"]["hardwareIds"], ["h1"])
        self.assertTrue(response.json()["decision"]["carriedHardware"][0]["inside"])
        async with self.sessions() as db:
            state = await db.get(PresenceState, "h1")
            self.assertEqual(state.state, "inside")
            self.assertEqual(state.entry_building_id, "public")
            self.assertIsNone(state.last_scan_timestamp)

    async def test_recovery_keeps_checkpoint_binding_and_idempotency_owner_checks(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "unknown-recovery", "checkpointId": "cp-main"}
        key = str(uuid.uuid4())
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            original = await self._scan(body, key)
            self.assertEqual(original.status_code, 200, original.text)
            self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}
            foreign = await self._scan(body, key)
            self.assertEqual(foreign.status_code, 409, foreign.text)
            self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
            async with self.sessions() as db:
                assignment = await db.get(TerminalCheckpointAssignment, "browser:test-operator")
                assignment.checkpoint_id = "server-room"
                await db.commit()
            reassigned = await self._scan(body, key)
            self.assertEqual(reassigned.status_code, 403, reassigned.text)
            async with self.sessions() as db:
                assignment = await db.get(TerminalCheckpointAssignment, "browser:test-operator")
                assignment.checkpoint_id = "cp-main"
                await db.commit()
            restored = await self._scan({**body, "expectedOperatorSubject": "test-operator"}, key)
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(restored.json(), database_tests.replay_receipt(original.json()))
            changed_payload = await self._scan({**body, "barcode": "another-barcode"}, key)
            self.assertEqual(changed_payload.status_code, 409, changed_payload.text)

    async def test_expected_operator_mismatch_rejects_fresh_or_cached_scan_without_writes(self):
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "unknown-owner-mismatch", "checkpointId": "cp-main",
            "expectedOperatorSubject": "operator"}
        response = await self._scan(body)
        self.assertEqual(response.status_code, 403, response.text)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ScanRequest)), 0)
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            key = str(uuid.uuid4())
            original = await self._scan({**body, "expectedOperatorSubject": "test-operator"}, key)
            self.assertEqual(original.status_code, 200, original.text)
            rejected_replay = await self._scan(body, key)
            self.assertEqual(rejected_replay.status_code, 403, rejected_replay.text)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ScanRequest)), 1)


class TerminalOwnerGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_account_guard_runs_before_db_access_and_certificate_paths_remain_separate(self):
        for identity in ("browser:other-operator", "certificate:operator"):
            db = AsyncMock()
            payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main", expectedOperatorSubject="operator")
            with self.assertRaises(HTTPException) as raised:
                await record_scan(db, uuid.uuid4(), payload, identity)
            self.assertEqual(raised.exception.status_code, 403)
            db.execute.assert_not_awaited()
            db.get.assert_not_awaited()
            db.flush.assert_not_awaited()
