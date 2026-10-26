"""Recover snapshot/subscribe gaps, duplicate delivery and bounded stream backlog."""
import asyncio
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from routers import presence


def change(revision, previous, **fields):
    return {"type": "data_changed", "revision": revision, "previousRevision": previous, **fields}


class PresenceReplayTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, messages, watermarks, rows, *, role="admin", checkpoints=None):
        subscribed = asyncio.Event()

        async def subscribe(ready):
            subscribed.set()
            ready.set()
            for message in messages:
                yield json.dumps(message) if message is not None else None

        async def watermark(_db):
            self.assertTrue(subscribed.is_set())
            return watermarks.pop(0)

        async def replay(_db, after, through):
            if rows is None:
                return None
            return [(row["revision"], row) for row in rows if after < row["revision"] <= through]

        sessions = AsyncMock()
        request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
        claims = {"sub": role, "realm_access": {"roles": [role]}}
        with patch.object(presence, "subscribe_presence", subscribe), \
             patch.object(presence, "AsyncSessionLocal", return_value=sessions), \
             patch.object(presence, "read_event_revision", new=AsyncMock(side_effect=watermark)), \
             patch.object(presence, "replay_events", new=AsyncMock(side_effect=replay)), \
             patch.object(presence, "_current_checkpoint", new=AsyncMock(side_effect=checkpoints or [])) as assignment:
            frames = [frame async for frame in presence._versioned_sse(request, time.time() + 60, claims, 0)]
        return frames, assignment

    async def test_subscribe_precedes_catch_up_and_replayed_duplicates_are_discarded(self):
        row = change(1, 0)
        frames, _ = await self.collect([row, row], [1], [row])
        self.assertEqual(sum('"type":"data_changed"' in frame for frame in frames), 1)
        self.assertIn("event: ready", frames[1])
        self.assertIn("id: 1", frames[1])

    async def test_out_of_order_publication_replays_missing_committed_predecessors(self):
        rows = [change(1, 0), change(3, 1), change(4, 3)]
        frames, _ = await self.collect([rows[2], rows[0], rows[2]], [0], rows)
        data_frames = [frame for frame in frames if "data: " in frame and "event:" not in frame]
        self.assertEqual([int(frame.split("id: ", 1)[1].split("\n", 1)[0]) for frame in data_frames], [1, 3, 4])
        self.assertEqual([json.loads(frame.split("data: ", 1)[1].split("\n", 1)[0]) for frame in data_frames],
                         [{"type": "data_changed"}] * 3)

    async def test_heartbeat_repairs_committed_event_before_redis_delivery(self):
        row = change(2, 0)
        frames, _ = await self.collect([None], [0, 2], [row])
        self.assertTrue(any("id: 2\n" in frame and '"type":"data_changed"' in frame for frame in frames))
        self.assertEqual(frames[-1], ": heartbeat\n\n")

    async def test_unrecoverable_or_excessive_backlog_requires_snapshot(self):
        frames, _ = await self.collect([], [20], None)
        self.assertEqual(len(frames), 1)
        self.assertIn("event: snapshot_required", frames[0])
        rows = [change(index, index - 1) for index in range(1, 300)]
        frames, _ = await self.collect(rows, [0], [])
        self.assertEqual(len(frames), 1)
        self.assertIn("event: snapshot_required", frames[0])
        large = [change(index, index - 1, padding="x" * 200_000) for index in range(1, 9)]
        frames, _ = await self.collect(large, [0], [])
        self.assertEqual(len(frames), 1)
        self.assertIn("event: snapshot_required", frames[0])

    async def test_operator_cursors_never_include_private_documents_or_other_assignment(self):
        rows = [change(1, 0, type="scan", movement={"checkpointId": "secure", "barcode": "private"}),
                change(2, 1, type="terminal_assignment", terminalIdentity="browser:other"),
                change(3, 2, type="scan", movement={"checkpointId": "cp-main", "barcode": "private"}),
                change(4, 3, type="terminal_assignment", terminalIdentity="browser:operator")]
        frames, assignment = await self.collect(rows, [0], rows, role="operator", checkpoints=["cp-main", None])
        joined = "".join(frames)
        self.assertNotIn("private", joined)
        self.assertNotIn("browser:other", joined)
        self.assertIn("event: cursor", joined)
        self.assertIn('"type":"data_changed"', joined)
        self.assertIn('"type":"terminal_assignment"', joined)
        self.assertEqual(assignment.await_count, 2)

