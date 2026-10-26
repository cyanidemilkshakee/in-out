"""Database deadlines reject safely and release transactions/connections."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import database
from config import Settings
from models import Person, Subject
import test_database as fixture


class DriverTimeout(Exception):
    sqlstate = "57014"


class DatabaseTimeoutUnitTests(unittest.IsolatedAsyncioTestCase):
    def test_defaults_and_invalid_unbounded_configuration(self):
        configured = Settings(_env_file=None)
        self.assertEqual((configured.DATABASE_CONNECT_TIMEOUT_SECONDS, configured.DATABASE_POOL_TIMEOUT_SECONDS,
            configured.DATABASE_STATEMENT_TIMEOUT_MS, configured.DATABASE_LOCK_TIMEOUT_MS), (5, 5, 15000, 3000))
        for values in ({"DATABASE_CONNECT_TIMEOUT_SECONDS": 0}, {"DATABASE_POOL_TIMEOUT_SECONDS": 31},
                       {"DATABASE_STATEMENT_TIMEOUT_MS": 0}, {"DATABASE_LOCK_TIMEOUT_MS": 30001},
                       {"DATABASE_STATEMENT_TIMEOUT_MS": 100, "DATABASE_LOCK_TIMEOUT_MS": 200}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                Settings(_env_file=None, **values)
        options = database.database_engine_options(configured)
        self.assertEqual(options["connect_args"]["command_timeout"], 20)
        self.assertEqual(options["connect_args"]["server_settings"],
            {"statement_timeout": "15000", "lock_timeout": "3000"})

    def test_timeout_classification_uses_types_and_sqlstates_without_messages(self):
        wrapped = DBAPIError("secret SQL", {"token": "secret parameter"}, DriverTimeout("secret driver message"))
        self.assertTrue(database.is_database_timeout(wrapped))
        self.assertTrue(database.is_database_timeout(PoolTimeoutError("pool exhausted")))
        self.assertTrue(database.is_database_timeout(TimeoutError()))
        self.assertFalse(database.is_database_timeout(RuntimeError("57014 statement timeout")))
        self.assertFalse(database.is_database_timeout(ValueError("bad input")))

    async def test_both_dependencies_rollback_before_propagating_error_or_cancellation(self):
        for dependency, factory in ((database.get_db, "AsyncSessionLocal"),
                                    (database.get_read_db, "AsyncReadSessionLocal")):
            for failure in (DriverTimeout("private SQL"), asyncio.CancelledError()):
                with self.subTest(dependency=dependency.__name__, failure=type(failure).__name__):
                    session = AsyncMock()
                    session.__aenter__.return_value = session
                    with patch.object(database, factory, Mock(return_value=session)):
                        stream = dependency()
                        self.assertIs(await anext(stream), session)
                        with self.assertRaises(type(failure)):
                            await stream.athrow(failure)
                    session.rollback.assert_awaited_once()
                    session.__aexit__.assert_awaited_once()

    async def test_failed_rollback_invalidates_connection_and_preserves_original_error(self):
        session = AsyncMock()
        session.__aenter__.return_value = session
        session.rollback.side_effect = RuntimeError("private rollback SQL")
        original = DriverTimeout("original private SQL")
        with patch.object(database, "AsyncSessionLocal", Mock(return_value=session)), \
             self.assertLogs("database", level="WARNING") as captured:
            stream = database.get_db()
            await anext(stream)
            with self.assertRaises(DriverTimeout) as raised:
                await stream.athrow(original)
        self.assertIs(raised.exception, original)
        session.invalidate.assert_awaited_once()
        self.assertNotIn("private", repr(captured.records[0].__dict__))

    async def test_connect_handshake_has_finite_deadline(self):
        release, connected = asyncio.Event(), asyncio.Event()
        writers, handlers = [], []

        async def stall(reader, writer):
            writers.append(writer)
            handlers.append(asyncio.current_task())
            connected.set()
            await release.wait()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(stall, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        configured = Settings(_env_file=None, DATABASE_CONNECT_TIMEOUT_SECONDS=0.1)
        engine = create_async_engine(f"postgresql+asyncpg://test:test@127.0.0.1:{port}/inout_test?ssl=disable",
            **database.database_engine_options(configured))
        try:
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(engine.connect(), timeout=3)
            self.assertTrue(connected.is_set())
        finally:
            release.set()
            server.close()
            await server.wait_closed()
            await asyncio.gather(*handlers, return_exceptions=True)
            await engine.dispose()


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class DatabaseTimeoutPostgresTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    def bounded_engine(self, **overrides):
        configured = Settings(_env_file=None, DATABASE_STATEMENT_TIMEOUT_MS=250,
            DATABASE_LOCK_TIMEOUT_MS=100, DATABASE_POOL_TIMEOUT_SECONDS=0.1)
        options = database.database_engine_options(configured)
        options["connect_args"]["server_settings"]["search_path"] = f"{self.schema},public"
        options.update(overrides)
        engine = create_async_engine(fixture.TEST_URL, **options)
        self.addAsyncCleanup(engine.dispose)
        return engine

    async def test_statement_timeout_rolls_back_all_writes_and_connection_recovers(self):
        sessions = async_sessionmaker(self.bounded_engine(), expire_on_commit=False)
        async with sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "name": "Must roll back"}
            await db.flush()
            with self.assertRaises(DBAPIError) as raised:
                await asyncio.wait_for(db.execute(text("SELECT pg_sleep(2)")), timeout=3)
            self.assertTrue(database.is_database_timeout(raised.exception))
            self.assertEqual(raised.exception.orig.sqlstate, "57014")
            await db.rollback()
            self.assertEqual((await db.get(Person, "p1")).data["name"], "Alice")
            self.assertEqual(await db.scalar(text("SELECT 1")), 1)

    async def test_lock_wait_times_out_without_mutation_and_session_recovers(self):
        sessions = async_sessionmaker(self.bounded_engine(), expire_on_commit=False)
        async with self.sessions() as owner, sessions() as blocked:
            await owner.scalar(select(Subject).where(Subject.id == "p1").with_for_update())
            with self.assertRaises(DBAPIError) as raised:
                await asyncio.wait_for(blocked.scalar(select(Subject).where(
                    Subject.id == "p1").with_for_update()), timeout=3)
            self.assertEqual(raised.exception.orig.sqlstate, "55P03")
            self.assertTrue(database.is_database_timeout(raised.exception))
            await blocked.rollback()
            await owner.rollback()
            self.assertIsNotNone(await blocked.scalar(select(Subject).where(Subject.id == "p1").with_for_update()))
            await blocked.commit()

    async def test_pool_checkout_deadline_releases_capacity_after_owner_closes(self):
        engine = self.bounded_engine(pool_size=1, max_overflow=0)
        async with engine.connect():
            with self.assertRaises(PoolTimeoutError):
                await asyncio.wait_for(engine.connect(), timeout=3)
        async with engine.connect() as recovered:
            self.assertEqual(await recovered.scalar(text("SELECT 1")), 1)

    async def test_http_timeout_rolls_back_before_returning_safe_503(self):
        import httpx
        from fastapi import Depends, FastAPI
        from sqlalchemy.ext.asyncio import AsyncSession
        from api_errors import install_api_error_handlers

        sessions = async_sessionmaker(self.bounded_engine(), expire_on_commit=False)
        app = FastAPI()
        install_api_error_handlers(app)

        @app.post("/write-then-timeout")
        async def write_then_timeout(db: AsyncSession = Depends(database.get_db)):
            person = await db.get(Person, "p1")
            person.data = {**person.data, "name": "Private uncommitted name"}
            await db.flush()
            await db.execute(text("SELECT pg_sleep(2)"))

        with patch.object(database, "AsyncSessionLocal", sessions), self.assertLogs("api_errors", level="WARNING"):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                        base_url="http://test") as client:
                response = await client.post("/write-then-timeout")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["error"]["code"], "database_timeout")
        self.assertEqual(response.headers["Retry-After"], "1")
        self.assertNotIn("Private", response.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(Person, "p1")).data["name"], "Alice")


if __name__ == "__main__":
    unittest.main()
