"""Run with TEST_DATABASE_URL pointing to a dedicated database ending in _test."""
import os
import sys
import uuid
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch
import importlib.util
from alembic.migration import MigrationContext
from alembic.operations import Operations

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI, Depends
from sqlalchemy import text, select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.engine import make_url
from database import Base, get_db, get_read_db
from models import Subject, Person, HardwareAsset, Checkpoint, Movement, PresenceState
from schemas import BrowserScanPayload
from terminal_scans import record_scan
from auth import verify_admin_request, verify_terminal_operator_request
from routers import movements, terminal

TEST_URL = os.getenv("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not make_url(TEST_URL).database.endswith("_test"):
            raise RuntimeError("Integration tests require a database ending in _test")
        self.schema = "test_" + uuid.uuid4().hex
        self.engine = create_async_engine(TEST_URL, connect_args={"server_settings": {"search_path": self.schema}})
        async with self.engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
            def migrate(connection):
                spec = importlib.util.spec_from_file_location("initial", Path(__file__).resolve().parents[1] / "alembic/versions/b4e1548478d0_initial_schema.py")
                migration = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(migration)
                with Operations.context(MigrationContext.configure(connection)):
                    migration.upgrade()
            await conn.run_sync(migrate)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as db:
            db.add(Checkpoint(id="cp1", data={"id": "cp1", "name": "Main", "mode": "auto", "zone": "Office"}))
            db.add(Subject(id="p1", kind="employee", barcode="p1", person=Person(data={
                "name": "Alice", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            db.add(Subject(id="h1", kind="hardware", barcode="h1", hardware=HardwareAsset(data={
                "name": "Laptop", "category": "Laptop", "status": "active", "allowedZones": ["All Zones"], "inside": False})))
            await db.commit()
        self.app = FastAPI()
        self.app.include_router(movements.router, dependencies=[Depends(verify_admin_request)])
        self.app.include_router(terminal.router, dependencies=[Depends(verify_terminal_operator_request)])
        async def session():
            async with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = session
        self.app.dependency_overrides[get_read_db] = session
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        async with self.engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.engine.dispose()

    async def test_unauthenticated_reads_and_writes_are_rejected(self):
        self.assertEqual((await self.client.get("/v1/movements")).status_code, 401)
        self.assertEqual((await self.client.post("/v1/terminal/scans", json={})).status_code, 401)

    async def test_browser_scan_retry_hardware_and_movement_filters(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "test-admin"}
        self.app.dependency_overrides[verify_terminal_operator_request] = lambda: {"sub": "test-operator"}
        body = {"barcode": "p1", "checkpointId": "cp1", "selectedHardwareIds": ["h1"], "scanType": "auto", "online": True}
        headers = {"Idempotency-Key": str(uuid.uuid4())}
        with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
            response = await self.client.post("/v1/terminal/scans", json=body, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertEqual(result["decision"]["event"]["subjectName"], "Alice")
            self.assertTrue(result["updatedPeople"][0]["inside"])
            self.assertTrue(result["updatedHardwareAssets"][0]["inside"])
            retry = await self.client.post("/v1/terminal/scans", json=body, headers=headers)
            self.assertEqual(retry.json(), result)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 1)
            # Cooldown has elapsed; auto mode must derive an exit from persisted presence.
            state = await db.get(PresenceState, "p1")
            state.last_scan_timestamp = datetime.now(timezone.utc) - timedelta(seconds=11)
            await db.commit()
            exit_result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(**body), "browser:test-admin")
            self.assertEqual(exit_result["decision"]["event"]["direction"], "exit")
            self.assertTrue(exit_result["allowed"])
            await db.commit()
        page = await self.client.get("/v1/movements", params={"search": "Alice", "checkpoint": "Main", "scanType": "auto", "subjectGroup": "people", "pageSize": 1, "page": 2})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["total"], 2)
        self.assertEqual(len(page.json()["items"]), 1)
        for params in ({"search": "Missing"}, {"scanType": "manual"}, {"subjectGroup": "hardware"}, {"startAt": "2099-01-01T00:00:00Z"}, {"endAt": "2000-01-01T00:00:00Z"}):
            self.assertEqual((await self.client.get("/v1/movements", params=params)).json()["total"], 0)

    async def test_direct_hardware_scan_and_custody_denial(self):
        async with self.sessions() as db:
            asset = await db.get(HardwareAsset, "h1")
            asset.data = {**asset.data, "assignedEmployeeId": "someone-else"}
            await db.commit()
            denied = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="p1", checkpointId="cp1", selectedHardwareIds=["h1"]), "test")
            self.assertFalse(denied["allowed"])
            self.assertEqual(denied["decision"]["event"]["denialCode"], "custody_mismatch")
            await db.commit()
            approved = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode="h1", checkpointId="cp1"), "test")
            self.assertTrue(approved["allowed"])
            self.assertEqual(approved["decision"]["event"]["subjectType"], "hardware")
            await db.commit()
