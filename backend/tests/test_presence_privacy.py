"""Presence authorization with synthetic JWTs, database rows, and Redis events."""
import json
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI
from database import get_read_db
from routers import presence


class PresencePrivacyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Privacy fixtures mock identity/event I/O independently of admission.
        lease = SimpleNamespace(id="privacy-test", principal_key="privacy-test", expires_at=time.time() + 300)
        admission_mocks = {
            "routers.presence.acquire_stream_lease": AsyncMock(return_value=lease),
            "routers.presence.renew_stream_lease": AsyncMock(return_value=True),
            "routers.presence.release_stream_lease": AsyncMock(return_value=None),
        }
        for target, mock in admission_mocks.items():
            admission = patch(target, new=mock)
            admission.start()
            self.addCleanup(admission.stop)
        self.app = FastAPI()
        self.app.include_router(presence.router)
        now = datetime.now(timezone.utc)
        self.db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(
            SimpleNamespace(subject_id="private-subject", state="inside", last_scan_timestamp=now, updated_at=now),
            SimpleNamespace(kind="employee", barcode="PRIVATE-BARCODE"),
        )])))
        self.app.dependency_overrides[get_read_db] = lambda: self.db

    @staticmethod
    def claims(token):
        return {"sub": token, "exp": time.time() + 300, "realm_access": {"roles": [token]}}

    async def fetch(self, path, role):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(self.app), base_url="http://isolated") as client:
            return await client.get(path, headers={"Authorization": "Bearer " + role})

    async def test_snapshot_is_admin_only(self):
        with patch("auth.verify_keycloak_token", side_effect=self.claims):
            self.assertEqual((await self.fetch("/v1/presence", "operator")).status_code, 403)
            self.assertEqual((await self.fetch("/v1/presence", "no-role")).status_code, 403)
            self.db.execute.assert_not_awaited()
            administrator = await self.fetch("/v1/presence", "admin")
            self.assertEqual(administrator.status_code, 200)
            self.assertEqual(administrator.json()[0]["barcode"], "PRIVATE-BARCODE")

    async def stream(self, role, messages, assignments):
        async def subscribe():
            for message in messages:
                yield json.dumps(message) if message is not None else None
        with patch("auth.verify_keycloak_token", side_effect=self.claims), \
             patch("routers.presence.subscribe_presence", subscribe), \
             patch("routers.presence._current_checkpoint", new=AsyncMock(side_effect=assignments)) as assignment:
            response = await self.fetch("/v1/presence/stream", role)
        self.assertEqual(response.status_code, 200)
        return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")], assignment

    async def test_operator_gets_only_checkpoint_refresh_hints(self):
        messages = [
            {"type": "manual_review_decision", "request": {"id": "private", "checkpointId": "server-room", "decisionReason": "Private admin note"},
             "people": [{"id": "private-subject", "phone": "private telephone"}]},
            {"type": "scan", "movement": {"checkpointId": "cp-main", "barcode": "SCANNED-BARCODE"}, "people": [{"id": "p1", "phone": "private telephone"}]},
            {"type": "manual_review_decision", "request": {"checkpointId": "cp-main", "decisionReason": "Private admin note"}, "permission": {"private": True}},
            {"type": "terminal_assignment", "terminalIdentity": "browser:other"},
            {"type": "terminal_assignment", "terminalIdentity": "browser:operator"},
            {"type": "data_changed", "auditEvent": {"actor": "Private administrator"}},
            {"type": "unknown", "movement": {"checkpointId": "cp-main"}},
        ]
        events, assignment = await self.stream("operator", messages, ["cp-main"] * (len(messages) + 1))
        self.assertEqual(events, [{"type": "data_changed"}, {"type": "data_changed"}, {"type": "terminal_assignment"}, {"type": "data_changed"}])
        self.assertEqual(assignment.await_count, len(messages) + 1)
        administrator, lookup = await self.stream("admin", messages, [])
        self.assertEqual(administrator, [{"type": "data_changed"}] * len(messages))
        lookup.assert_not_awaited()

    async def test_unassigned_operator_gets_no_private_updates(self):
        messages = [
            {"type": "scan", "movement": {"checkpointId": "cp-main", "barcode": "private"}},
            {"type": "data_changed", "people": [{"phone": "private"}]},
            {"type": "terminal_assignment", "terminalIdentity": "browser:operator", "private": True},
        ]
        events, _ = await self.stream("operator", messages, [None] * 4)
        self.assertEqual(events, [{"type": "terminal_assignment"}])

    async def test_unrelated_events_do_not_emit_extra_heartbeats(self):
        async def subscribe():
            yield json.dumps({"type": "scan", "movement": {"checkpointId": "server-room"}})
            yield None
        with patch("auth.verify_keycloak_token", side_effect=self.claims), \
             patch("routers.presence.subscribe_presence", subscribe), \
             patch("routers.presence._current_checkpoint", new=AsyncMock(return_value="cp-main")):
            response = await self.fetch("/v1/presence/stream", "operator")
        self.assertEqual(response.text, ": heartbeat\n\n")

    async def test_reassignment_and_revocation_take_effect_during_stream(self):
        messages = [
            {"type": "scan", "movement": {"checkpointId": "cp-main", "barcode": "old-checkpoint"}},
            {"type": "scan", "movement": {"checkpointId": "server-room", "barcode": "revoked-checkpoint"}},
        ]
        events, assignment = await self.stream("operator", messages, ["cp-main", "server-room", None])
        self.assertEqual(events, [{"type": "terminal_assignment"}, {"type": "terminal_assignment"}])
        self.assertEqual(assignment.await_count, 3)

    async def test_heartbeat_rechecks_assignment_and_short_primary_session_closes(self):
        events, assignment = await self.stream("operator", [None], ["cp-main", None])
        self.assertEqual(events, [{"type": "terminal_assignment"}])
        self.assertEqual(assignment.await_count, 2)
        session = AsyncMock()
        session.scalar.return_value = "cp-main"
        context = AsyncMock()
        context.__aenter__.return_value = session
        with patch("routers.presence.AsyncSessionLocal", return_value=context):
            self.assertEqual(await presence._current_checkpoint(self.claims("operator")), "cp-main")
        context.__aexit__.assert_awaited_once()
        query = session.scalar.await_args.args[0]
        self.assertIn("terminal_checkpoint_assignments", str(query))
        self.assertEqual(list(query.compile().params.values()), ["browser:operator"])

    def test_malformed_global_messages_are_dropped(self):
        for value in ("null", "[]", "not json", '{"type":"scan","movement":[]}'):
            self.assertIsNone(presence._operator_refresh_event(value, "cp-main", "browser:operator"))


if __name__ == "__main__":
    unittest.main()
