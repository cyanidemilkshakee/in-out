"""Rehearse the additive search migration and inspect the real query plan."""
import asyncio
import json
from pathlib import Path
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

import test_database as fixture
from models import Movement
from routers.movements import _movement_filters


INDEX_NAME = "idx_movements_search_full_trgm"


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class MovementSearchIndexTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def migrate(self, direction):
        async with self.engine.begin() as connection:
            def apply(sync_connection):
                migration = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic")).get_revision(
                    "c7d8e9f0a1").module
                with Operations.context(MigrationContext.configure(sync_connection)):
                    getattr(migration, direction)()
            await connection.run_sync(apply)

    async def explain_search(self, phase):
        filters = _movement_filters(search="needle-id-19337", checkpoint=None, scan_type_ui=None,
            subject_group=None, start_at=None, end_at=None, subject_id=None, result=None, direction=None,
            scan_type=None, subject_type=None, since=None)
        query = select(Movement.id).where(*filters)
        # Only generated synthetic fixture values are embedded in this plan.
        sql = str(query.compile(dialect=self.engine.sync_engine.dialect,
            compile_kwargs={"literal_binds": True}))
        async with self.sessions() as db:
            plan = await db.scalar(text("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql))
            ids = list(await db.scalars(query))
            self.assertEqual(ids, ["needle-id-19337"])
        print("MOVEMENT_SEARCH_EXPLAIN " + json.dumps({"phase": phase, "rows": 20000, "plan": plan}, separators=(",", ":")))
        return json.dumps(plan)

    async def test_upgrade_downgrade_reupgrade_preserves_rows_and_uses_matching_index(self):
        async with self.engine.begin() as connection:
            await connection.execute(text("""
                INSERT INTO movements(id,subject_id,checkpoint_id,occurred_at,result,direction,scan_type,subject_type,sync_state,data)
                SELECT CASE WHEN number=19337 THEN 'needle-id-19337' ELSE 'fixture-event-'||number END,
                    'p1','cp-main',now(),'approved','entry','auto','employee','synced',
                    jsonb_build_object('subjectName','Synthetic Person','barcode','synthetic-barcode',
                        'checkpoint','Main Entrance','reason','Synthetic allowed scan')
                FROM generate_series(1,20000) number
            """))
            await connection.execute(text("ANALYZE movements"))
        self.assertIn(INDEX_NAME, await self.explain_search("upgrade"))
        await self.migrate("downgrade")
        self.assertNotIn(INDEX_NAME, await self.explain_search("downgrade"))
        async with self.sessions() as db:
            old_index = await db.scalar(text("SELECT indexname FROM pg_indexes WHERE schemaname=:schema AND indexname=:name"),
                {"schema": self.schema, "name": "idx_movements_search_trgm"})
            self.assertEqual(old_index, "idx_movements_search_trgm")
        await self.migrate("upgrade")
        self.assertIn(INDEX_NAME, await self.explain_search("reupgrade"))
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(text("SELECT count(*) FROM movements")), 20000)
            definition = await db.scalar(text("SELECT indexdef FROM pg_indexes WHERE schemaname=:schema AND indexname=:name"),
                {"schema": self.schema, "name": INDEX_NAME})
            self.assertIn("lower(", definition)
            self.assertIn("id ||", definition)

    async def test_blocked_index_build_times_out_and_retains_previous_index(self):
        await self.migrate("downgrade")
        async with self.sessions() as writer:
            await writer.execute(text("LOCK TABLE movements IN ROW EXCLUSIVE MODE"))
            with self.assertRaises(DBAPIError) as raised:
                await asyncio.wait_for(self.migrate("upgrade"), timeout=8)
            self.assertEqual(raised.exception.orig.sqlstate, "55P03")
            await writer.rollback()
        async with self.sessions() as db:
            names = set(await db.scalars(text("SELECT indexname FROM pg_indexes WHERE schemaname=:schema"),
                {"schema": self.schema}))
            self.assertIn("idx_movements_search_trgm", names)
            self.assertNotIn(INDEX_NAME, names)
        await self.migrate("upgrade")


if __name__ == "__main__":
    unittest.main()
