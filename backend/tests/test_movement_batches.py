"""Maintenance is explicit, bounded and atomic; it never changes presence."""
import asyncio
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select, text

import test_database as fixture
from auth import verify_admin_request
from models import EventOutbox, Movement, Person
from routers.movements import ConflictResolveRequest, SyncRequest, _sync_movement_batch


class MovementBatchSchemaTests(unittest.TestCase):
    def test_both_routes_require_explicit_bounded_unique_nonempty_identifiers(self):
        for model in (SyncRequest, ConflictResolveRequest):
            for payload in ({}, {"eventIds": None}, {"eventIds": []}, {"eventIds": [""]},
                            {"eventIds": ["   "]}, {"eventIds": ["x" * 129]},
                            {"eventIds": ["a", " a "]}, {"eventIds": [1]},
                            {"eventIds": [str(i) for i in range(201)]}):
                with self.subTest(model=model.__name__, payload_type=type(payload.get("eventIds"))):
                    with self.assertRaises(ValidationError):
                        model.model_validate(payload)
            self.assertEqual(model(eventIds=[" a ", "b"]).eventIds, ["a", "b"])
            self.assertEqual(len(model(eventIds=[str(i) for i in range(200)]).eventIds), 200)


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class MovementBatchTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "admin"}

    async def add_movements(self, count=3, state="queued", prefix="queued", note="paper ledger"):
        ids = [f"{prefix}-{i:03}" for i in range(count)]
        async with self.sessions() as db:
            for identifier in ids:
                db.add(Movement(id=identifier, subject_id="p1", checkpoint_id="cp-main",
                    occurred_at=datetime.now(timezone.utc), result="approved", direction="entry",
                    scan_type="manual", subject_type="employee", sync_state=state,
                    data={"id": identifier, "reason": note, "syncState": state}))
            await db.commit()
        return ids

    async def states_and_event_count(self):
        async with self.sessions() as db:
            return dict((await db.execute(select(Movement.id, Movement.sync_state))).all()), \
                await db.scalar(select(func.count()).select_from(EventOutbox))

    async def test_maintenance_routes_require_admin_and_reject_invalid_batches_without_writes(self):
        ids = await self.add_movements()
        for path in ("/v1/movements/sync", "/v1/movements/conflicts/resolve"):
            self.assertEqual((await self.client.post(path, json={"eventIds": ids})).status_code, 401)
            self.authorize()
            for payload in ({}, {"eventIds": None}, {"eventIds": []}, {"eventIds": ids * 100}):
                self.assertEqual((await self.client.post(path, json=payload)).status_code, 422)
            self.app.dependency_overrides.pop(verify_admin_request)
        states, event_count = await self.states_and_event_count()
        self.assertEqual(set(states.values()), {"queued"})
        self.assertEqual(event_count, 0)

    async def test_sync_changes_only_selected_queued_rows_and_retries_do_not_enqueue_noops(self):
        self.authorize()
        queued = await self.add_movements()
        conflicts = await self.add_movements(1, "conflict", "conflict")
        payload = {"eventIds": [queued[0], conflicts[0], "absent"]}
        response = await self.client.post("/v1/movements/sync", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["id"] for row in response.json()], [queued[0]])
        self.assertEqual(response.json()[0]["syncState"], "synced")
        retry = await self.client.post("/v1/movements/sync", json=payload)
        self.assertEqual(retry.json(), [])
        states, event_count = await self.states_and_event_count()
        self.assertEqual(states[queued[0]], "synced")
        self.assertTrue(all(states[key] == "queued" for key in queued[1:]))
        self.assertEqual(states[conflicts[0]], "conflict")
        self.assertEqual(event_count, 1)
        async with self.sessions() as db:
            self.assertFalse((await db.get(Person, "p1")).data["inside"])

    async def test_conflicts_and_largest_supported_batch_remain_complete(self):
        self.authorize()
        ids = await self.add_movements(200, "conflict", "conflict")
        unrelated = await self.add_movements(1)
        response = await self.client.post("/v1/movements/conflicts/resolve", json={"eventIds": list(reversed(ids))})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([row["id"] for row in response.json()], ids)
        states, event_count = await self.states_and_event_count()
        self.assertTrue(all(states[key] == "synced" for key in ids))
        self.assertEqual(states[unrelated[0]], "queued")
        self.assertEqual(event_count, 1)

    async def test_byte_capacity_rejection_rolls_back_and_session_can_be_reused(self):
        ids = await self.add_movements(note="synthetic evidence " * 20)
        async with self.sessions() as db:
            with patch("routers.movements.settings.MAX_DATA_RESPONSE_BYTES", 32):
                with self.assertRaises(HTTPException) as raised:
                    await _sync_movement_batch(db, ids, "queued")
            self.assertEqual(raised.exception.status_code, 422)
            self.assertEqual(raised.exception.detail["code"], "movement_batch_response_too_large")
            self.assertEqual(await db.scalar(text("SELECT 1")), 1)
        states, event_count = await self.states_and_event_count()
        self.assertEqual(set(states.values()), {"queued"})
        self.assertEqual(event_count, 0)

    async def test_delivery_intent_failure_cannot_commit_a_partial_batch(self):
        ids = await self.add_movements()
        async with self.sessions() as db:
            with patch("routers.movements.enqueue_changed", side_effect=RuntimeError("fixture failure")):
                with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                    await _sync_movement_batch(db, ids, "queued")
            self.assertEqual(await db.scalar(text("SELECT 1")), 1)
        states, event_count = await self.states_and_event_count()
        self.assertEqual(set(states.values()), {"queued"})
        self.assertEqual(event_count, 0)

    async def test_overlapping_reversed_batches_serialize_without_duplicate_delivery(self):
        self.authorize()
        ids = await self.add_movements()
        first, second = await asyncio.gather(*[
            self.client.post("/v1/movements/sync", json={"eventIds": order}) for order in (ids, list(reversed(ids)))])
        self.assertEqual((first.status_code, second.status_code), (200, 200))
        self.assertEqual(sorted([len(first.json()), len(second.json())]), [0, len(ids)])
        states, event_count = await self.states_and_event_count()
        self.assertEqual(set(states.values()), {"synced"})
        self.assertEqual(event_count, 1)


if __name__ == "__main__":
    unittest.main()
