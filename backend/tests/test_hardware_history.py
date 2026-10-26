"""Carried hardware history is derived from the same committed scan as its carrier."""
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

import test_database as fixtures
from auth import verify_admin_request
from models import HardwareAsset, Movement, MovementNote, PermissionRequestModel, Person, PresenceState, Subject
from permission_decisions import apply_permission_decision
from schemas import BrowserScanPayload
from terminal_scans import record_scan


@unittest.skipUnless(fixtures.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class HardwareHistoryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.DatabaseTests.asyncSetUp
    asyncTearDown = fixtures.DatabaseTests.asyncTearDown

    async def _read(self, endpoint="/v1/movements", **params):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "history-admin"}
        response = await self.client.get(endpoint, params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def _scan(self, *, key=None, hardware=None):
        payload = BrowserScanPayload(barcode="p1", checkpointId="cp-main",
            selectedHardwareIds=hardware if hardware is not None else ["h1"])
        async with self.sessions() as db:
            result = await record_scan(db, key or uuid.uuid4(), payload, "test:hardware-history")
            await db.commit()
            return result

    async def _allow_next_scan(self):
        async with self.sessions() as db:
            for state in (await db.scalars(select(PresenceState))).all():
                state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            await db.commit()

    async def test_carried_entry_exit_appear_with_asset_identity_without_duplicate_source_scans(self):
        key = uuid.uuid4()
        entered = await self._scan(key=key)
        self.assertTrue(entered["allowed"], entered)
        self.assertEqual((await self._scan(key=key))["decision"]["event"]["id"], entered["decision"]["event"]["id"])
        await self._allow_next_scan()
        exited = await self._scan()
        self.assertTrue(exited["allowed"], exited)

        hardware = await self._read(subjectGroup="hardware")
        self.assertEqual(hardware["total"], 2)
        self.assertEqual({row["direction"] for row in hardware["items"]}, {"entry", "exit"})
        self.assertEqual({row["data"]["sourceEventId"] for row in hardware["items"]}, {
            entered["decision"]["event"]["id"], exited["decision"]["event"]["id"]})
        for row in hardware["items"]:
            self.assertNotEqual(row["id"], row["data"]["sourceEventId"])
            self.assertEqual(str(uuid.UUID(row["id"])), row["id"])
            self.assertEqual((row["subject_id"], row["subject_type"]), ("h1", "hardware"))
            self.assertEqual((row["data"]["subjectName"], row["data"]["barcode"]), ("Laptop", "h1"))
            self.assertEqual((row["data"]["carrierId"], row["data"]["carrierName"]), ("p1", "Alice"))
            self.assertEqual(row["data"]["hardwareIds"], [])
        person = await self._read(subjectGroup="people")
        self.assertEqual(person["total"], 2)
        self.assertEqual({row["subject_id"] for row in person["items"]}, {"p1"})
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 2)
            self.assertEqual((await db.get(PresenceState, "h1")).state, "outside")

    async def test_asset_filter_and_search_find_carried_history_and_keep_source_notes(self):
        entry = await self._scan()
        event_id = entry["decision"]["event"]["id"]
        async with self.sessions() as db:
            db.add(MovementNote(event_id=event_id, note="Laptop verified at gate", created_at=datetime.now(timezone.utc)))
            await db.commit()
        for params in ({"subject_id": "h1"}, {"subjectGroup": "hardware", "search": "Laptop"},
                {"subjectGroup": "hardware", "search": "h1"}):
            page = await self._read(**params)
            self.assertEqual(page["total"], 1)
            self.assertEqual(page["items"][0]["subject_id"], "h1")
            projected_id = page["items"][0]["id"]
            self.assertEqual(page["movementNotes"][projected_id], ["Laptop verified at gate"])
            exact = await self._read(eventId=projected_id, subjectGroup="people", startAt="2099-01-01")
            self.assertEqual(exact["items"][0]["subject_id"], "h1")
            self.assertEqual(exact["items"][0]["data"]["sourceEventId"], event_id)
        note_url = f"/v1/movements/{projected_id}/notes"
        self.assertEqual((await self.client.get(note_url)).json(), ["Laptop verified at gate"])
        mutation = await self.client.post(note_url, json={"note": "Carrier checked"})
        self.assertEqual(mutation.status_code, 200, mutation.text)
        self.assertEqual(mutation.json(), ["Laptop verified at gate", "Carrier checked"])
        self.assertEqual((await self.client.get(f"/v1/movements/{event_id}/notes")).json(), mutation.json())
        async with self.sessions() as db:
            self.assertEqual(set((await db.scalars(select(MovementNote.event_id))).all()), {event_id})
        direct = await self._read(eventId=event_id, subjectGroup="hardware")
        self.assertEqual(len(direct["items"]), 1)
        self.assertEqual(direct["items"][0]["subject_id"], "p1")

    async def test_multi_asset_paging_and_analytics_count_each_asset_once(self):
        async with self.sessions() as db:
            db.add(Subject(id="h2", kind="hardware", barcode="hardware-two", hardware=HardwareAsset(data={
                "name": "Tablet", "category": "Tablet", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            await db.commit()
        entry = await self._scan(hardware=["h1", "h2", "h1"])
        self.assertTrue(entry["allowed"], entry)
        pages = [await self._read(subjectGroup="hardware", pageSize=1, page=page) for page in (1, 2)]
        self.assertTrue(all(page["total"] == 2 for page in pages))
        self.assertEqual({page["items"][0]["subject_id"] for page in pages}, {"h1", "h2"})
        self.assertEqual(len({page["items"][0]["id"] for page in pages}), 2)
        summary = await self._read("/v1/movements/analytics", subjectGroup="hardware")
        self.assertEqual(summary["summary"], {"total": 2, "approved": 2, "denied": 0})
        self.assertEqual(sum(bucket["count"] for bucket in summary["buckets"]), 2)
        dashboard = await self._read("/v1/movements/dashboard-analytics", subjectGroup="hardware")
        self.assertEqual(dashboard["current"]["scanAnalytics"]["totalEntries"], 2)
        self.assertEqual(dashboard["current"]["scanAnalytics"]["activeInside"], 2)
        people = await self._read("/v1/movements/dashboard-analytics", subjectGroup="people")
        self.assertEqual(people["current"]["scanAnalytics"]["totalEntries"], 1)

    async def test_legacy_carried_ids_restore_history_without_rewriting_evidence(self):
        now = datetime.now(timezone.utc)
        original = {"id": "legacy-carrier", "subjectId": "p1", "subjectName": "Alice",
            "barcode": "p1", "hardwareIds": ["h1", "h1"], "checkpoint": "Main Entrance"}
        async with self.sessions() as db:
            db.add(Movement(id="legacy-carrier", subject_id="p1", subject_type="employee", checkpoint_id="cp-main",
                occurred_at=now, result="approved", direction="entry", scan_type="manual", sync_state="synced", data=original))
            await db.commit()
        for endpoint in ("/v1/movements", "/v1/movements/analytics"):
            page = await self._read(endpoint, subjectGroup="hardware")
            self.assertEqual(len(page["items"]), 1)
            item = page["items"][0]
            data = item.get("data", item)
            self.assertEqual(data["subjectName"], "Laptop")
            self.assertEqual(data["barcode"], "h1")
        async with self.sessions() as db:
            self.assertEqual((await db.get(Movement, "legacy-carrier")).data, original)

    async def test_new_history_keeps_asset_labels_after_registry_changes(self):
        await self._scan()
        async with self.sessions() as db:
            subject = await db.get(Subject, "h1")
            asset = await db.get(HardwareAsset, "h1")
            subject.barcode = "renamed-barcode"
            asset.data = {**asset.data, "name": "Renamed asset"}
            await db.commit()
        page = await self._read(subjectGroup="hardware")
        self.assertEqual(page["items"][0]["data"]["subjectName"], "Laptop")
        self.assertEqual(page["items"][0]["data"]["barcode"], "h1")

    async def test_direct_asset_scan_is_not_projected_twice(self):
        async with self.sessions() as db:
            result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp-main"), "test:asset")
            await db.commit()
        self.assertTrue(result["allowed"], result)
        page = await self._read(subjectGroup="hardware")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["id"], result["decision"]["event"]["id"])
        self.assertNotIn("sourceEventId", page["items"][0]["data"])

    async def test_denied_carrier_scan_is_visible_as_denied_without_hardware_admission(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            await db.commit()
        result = await self._scan()
        self.assertFalse(result["allowed"], result)
        page = await self._read(subjectGroup="hardware", result="denied", denialCategory="restricted")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["result"], "denied")
        async with self.sessions() as db:
            self.assertEqual((await db.get(PresenceState, "h1")).state, "outside")
            self.assertFalse((await db.get(HardwareAsset, "h1")).data["inside"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)

    async def test_replaced_carrier_and_projected_hardware_are_suppressed_but_exact_links_resolve(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            for event_id in ("original-carrier", "replacement-carrier"):
                db.add(Movement(id=event_id, subject_id="p1", subject_type="employee", checkpoint_id="cp-main",
                    occurred_at=now, result="denied", direction="entry", scan_type="manual", sync_state="synced",
                    data={"subjectName": "Alice", "barcode": "p1", "hardwareIds": ["h1"],
                        **({"overrideRequestId": "legacy-review"} if event_id == "replacement-carrier" else {})}))
            db.add(PermissionRequestModel(id="legacy-review", subject_id="p1", created_at=now,
                data={"type": "manual_override", "eventId": "original-carrier", "status": "denied"}))
            await db.commit()
        page = await self._read(subjectGroup="hardware")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["data"]["sourceEventId"], "replacement-carrier")
        summary = await self._read("/v1/movements/analytics", subjectGroup="hardware")
        self.assertEqual(summary["summary"]["total"], 1)
        self.assertEqual(summary["items"][0]["scanType"], "manual")
        original = await self._read(eventId="original-carrier")
        self.assertEqual(original["items"][0]["id"], "original-carrier")

    async def test_manual_admission_retains_hardware_history_and_approval_provenance(self):
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "status": "restricted"}
            await db.commit()
        denied = await self._scan()
        async with self.sessions() as db:
            request_id = await fixtures.DatabaseTests._create_review(self, db, "p1", "p1", denied["decision"]["event"])
            await apply_permission_decision(db, request_id, "approved", "history-admin", "Verified carrier and asset")
            await db.commit()
        entered = await self._scan()
        self.assertTrue(entered["allowed"], entered)
        exited = await self._scan()
        self.assertTrue(exited["allowed"], exited)
        hardware = await self._read(subjectGroup="hardware")
        self.assertEqual(hardware["total"], 3)
        approved = [row for row in hardware["items"] if row["result"] == "approved"]
        self.assertEqual({row["direction"] for row in approved}, {"entry", "exit"})
        reviewed_entry = next(row for row in approved if row["direction"] == "entry")
        self.assertEqual(reviewed_entry["scan_type"], "manual")
        self.assertEqual(reviewed_entry["data"]["manualApprovalRequestId"], request_id)
        self.assertEqual(reviewed_entry["data"]["sourceEventId"], entered["decision"]["event"]["id"])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 3)

    async def test_malformed_legacy_hardware_lists_do_not_break_history(self):
        async with self.sessions() as db:
            for index, hardware_ids in enumerate((None, {}, "h1", [None, {}, 1, "", "h1", "h1"])):
                db.add(Movement(id=f"malformed-{index}", subject_id="p1", subject_type="employee", checkpoint_id="cp-main",
                    occurred_at=datetime.now(timezone.utc), result="approved", direction="entry", scan_type="auto",
                    sync_state="synced", data={"hardwareIds": hardware_ids, "hardwareSnapshots": "invalid"}))
            await db.commit()
        page = await self._read(subjectGroup="hardware")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["subject_id"], "h1")

    async def test_carried_asset_with_recorded_history_cannot_be_deleted(self):
        await self._scan()
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "history-admin"}
        response = await self.client.delete("/v1/registry/subjects/h1")
        self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as db:
            self.assertIsNotNone(await db.get(Subject, "h1"))
            self.assertEqual((await db.get(PresenceState, "h1")).state, "inside")

    async def test_unused_asset_is_still_deletable_after_an_unrelated_person_scan(self):
        await self._scan(hardware=[])
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "history-admin"}
        response = await self.client.delete("/v1/registry/subjects/h1")
        self.assertEqual(response.status_code, 204, response.text)
        async with self.sessions() as db:
            self.assertIsNone(await db.get(Subject, "h1"))
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)

