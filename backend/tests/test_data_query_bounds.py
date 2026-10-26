"""Complete reads reject excess rows in SQL instead of returning sampled totals."""
import inspect
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from fastapi.params import Param
from sqlalchemy import select
from starlette.requests import Request
from sqlalchemy.dialects import postgresql

from config import settings
from data_limits import bounded_rows
from models import Movement, Subject
from movement_analytics import employee_activity, employee_activity_summary
from alert_rule_assignments import list_alert_rule_assignments
from alert_reviews import warning_directory, reset_subject_warnings
from alert_queries import command_center_assignments, confirmed_people_warning_total
from routers import movements, permissions, presence, registry, terminal
from schemas import BrowserScanPayload


class Result:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None

    def scalars(self):
        return Result([row[0] for row in self.rows])

    def scalar_one_or_none(self):
        return self.rows[0][0] if self.rows else None

    def scalar_one(self):
        return self.rows[0][0]


class Database:
    """Honor SQL LIMIT so tests distinguish bounds from fetching then slicing."""
    def __init__(self, *results):
        self.results = list(results)
        self.queries = []
        self.loaded = []
        self.scalar = AsyncMock(side_effect=lambda query: 0 if "event_stream_state" in str(query) else "p1")
        self.get = AsyncMock(return_value=SimpleNamespace(data={"mode": "auto"}, zone_id="public"))
        self.commit = AsyncMock()
        self.flush = AsyncMock()
        self.info = {}
        self.added = []

    async def execute(self, query):
        self.queries.append(query)
        rows = self.results.pop(0) if self.results else []
        limit = query._limit_clause.value if query._limit_clause is not None else None
        loaded = rows[:limit] if limit is not None else rows
        self.loaded.append(len(loaded))
        return Result(loaded)

    async def scalars(self, query):
        return (await self.execute(query)).scalars()

    def add(self, row):
        self.added.append(row)


async def call_endpoint(endpoint, **overrides):
    # Direct calls still use actual public Query defaults, just as FastAPI does.
    values = {name: parameter.default.default
              for name, parameter in inspect.signature(endpoint).parameters.items()
              if isinstance(parameter.default, Param)}
    values.update(overrides)
    return await endpoint(**values)


class DataQueryBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.snapshot = patch.object(settings, "DATA_SNAPSHOT_MAX_ROWS", 3)
        self.analytics = patch.object(settings, "DATA_ANALYTICS_MAX_ROWS", 3)
        self.snapshot.start()
        self.analytics.start()
        self.addCleanup(self.snapshot.stop)
        self.addCleanup(self.analytics.stop)

    async def rejected(self, coroutine, db, *, last_limit=4):
        with self.assertRaises(HTTPException) as error:
            await coroutine
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("complete read", error.exception.detail)
        self.assertEqual(db.queries[-1]._limit_clause.value, last_limit)
        self.assertEqual(db.loaded[-1], last_limit)

    async def test_sidebar_count_does_not_load_alert_documents_or_subject_directories(self):
        from routers import alerts
        db = Database([(7,)])
        result = await call_endpoint(alerts.list_alerts, db=db, view="count", status="active",
            actor={"sub": "admin", "realm_access": {"roles": ["admin"]}})
        self.assertEqual(result, {"total": 7, "eventRevision": 0})
        self.assertEqual(len(db.queries), 1)
        self.assertIn("count", str(db.queries[0]).lower())

    async def test_bounded_rows_keeps_exact_boundary_and_rejects_next_row_before_full_fetch(self):
        query = select(Subject).where(Subject.kind == "employee").order_by(Subject.id)
        exact = [("p1",), ("p2",), ("p3",)]
        db = Database(exact)
        self.assertEqual(await bounded_rows(db, query), exact)
        self.assertEqual(db.queries[0]._limit_clause.value, 4)
        self.assertIn("subjects.kind", str(db.queries[0]))
        self.assertIn("ORDER BY subjects.id", str(db.queries[0]))
        overflow = Database([(str(index),) for index in range(100)])
        await self.rejected(bounded_rows(overflow, query), overflow)
        self.assertEqual(overflow.loaded, [4])

    async def test_registry_rejects_excess_subject_permissions_and_requests(self):
        for prior_results in ([], [[]], [[], [], [], [], [], []]):
            with self.subTest(source=len(prior_results)):
                db = Database(*prior_results, [(None,)] * 100)
                await self.rejected(registry.registry_bundle(db=db,
                    actor={"sub": "admin", "realm_access": {"roles": ["admin"]}}), db)

    async def test_permissions_directory_rejects_every_complete_source(self):
        # Requests, distinct manual-assignment IDs, access rows, subjects.
        for count in range(4):
            with self.subTest(source=count):
                db = Database(*([[]] * count), [(None,)] * 100)
                await self.rejected(permissions.list_permissions(db=db,
                    _admin={"sub": "admin", "realm_access": {"roles": ["admin"]}}), db)

    async def test_rule_directory_rejects_catalog_subjects_and_override_excess(self):
        for count in range(3):
            with self.subTest(source=count):
                db = Database(*([[]] * count), [(None,)] * 100)
                await self.rejected(list_alert_rule_assignments(db), db)

    async def test_warning_directory_bounds_subjects_resets_and_grouped_counts(self):
        for count in range(3):
            with self.subTest(source=count):
                db = Database(*([[]] * count), [(None,)] * 100)
                await self.rejected(warning_directory(db), db)

    async def test_warning_directory_projects_only_names_and_keeps_full_history_counts(self):
        person = SimpleNamespace(id="p1", kind="employee", barcode="EMP-1")
        hardware = SimpleNamespace(id="h1", kind="hardware", barcode="ASSET-1")
        no_name = SimpleNamespace(id="p2", kind="employee", barcode="EMP-2")
        now = datetime.now(timezone.utc)
        reset = SimpleNamespace(subject_id="p1", reset_at=now, reset_by="admin", reason="Checked")
        db = Database([(person, "Alice"), (hardware, "Laptop"), (no_name, None)],
                      [(reset,)], [("p1", 50_001)])
        with patch("alert_reviews.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            subjects, by_id, by_barcode, summaries, resets = await warning_directory(db)
        self.assertEqual(subjects, [person, hardware, no_name])
        self.assertIs(by_id["p1"], person)
        self.assertEqual(by_barcode["emp-1"], [person])
        self.assertEqual(summaries["p1"]["count"], 50_001)
        self.assertEqual(summaries["p1"]["subjectName"], "Alice")
        self.assertEqual(summaries["h1"]["subjectName"], "Laptop")
        self.assertEqual(summaries["p2"]["subjectName"], "EMP-2")
        self.assertEqual(summaries["p1"]["resetReason"], "Checked")
        self.assertIs(resets["p1"], reset)
        projection = str(db.queries[0].compile(dialect=postgresql.dialect(),
                                              compile_kwargs={"literal_binds": True}))
        self.assertIn("people.data['name']", projection)
        self.assertIn("hardware_assets.data['name']", projection)
        self.assertNotIn("people.data AS", projection)
        aggregate = str(db.queries[2])
        self.assertIn("count(*)", aggregate)
        self.assertIn("GROUP BY alert_reviews.subject_id", aggregate)
        self.assertIn("alert_reviews.reviewed_at > warning_resets.reset_at", aggregate)
        self.assertNotIn("FROM (SELECT", aggregate)

    async def test_focused_warning_reads_constrain_names_resets_and_ledger_counts_to_displayed_people(self):
        person = SimpleNamespace(id="p1", kind="employee", barcode="EMP-1")
        db = Database([(person, "Alice")], [], [("p1", 2)])
        with patch("alert_reviews.entry_restrictions_for_subjects", new=AsyncMock(return_value={})):
            subjects, _, _, summaries, _ = await warning_directory(db, subject_ids=["p1"], barcodes=["legacy-1"])
        self.assertEqual(subjects, [person])
        self.assertEqual(summaries["p1"]["count"], 2)
        sql = [str(query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
            for query in db.queries]
        self.assertIn("subjects.id IN ('p1')", sql[0])
        self.assertIn("lower(subjects.barcode) IN ('legacy-1')", sql[0])
        self.assertIn("warning_resets.subject_id IN ('p1')", sql[1])
        self.assertIn("alert_reviews.subject_id IN ('p1')", sql[2])
        self.assertIn("count(*)", sql[2])

    async def test_command_center_counts_are_scalar_and_skip_schedule_excludes_unscheduled_people_in_sql(self):
        db = Database()
        db.scalar = AsyncMock(return_value=12_345)
        self.assertEqual(await confirmed_people_warning_total(db), 12_345)
        aggregate = str(db.scalar.await_args.args[0])
        self.assertIn("count(*)", aggregate)
        self.assertIn("alert_reviews.reviewed_at > warning_resets.reset_at", aggregate)
        self.assertIn("subjects.kind IN", aggregate)
        self.assertEqual(await command_center_assignments(db, []), [])
        schedule_sql = str(db.queries[0].compile(dialect=postgresql.dialect()))
        self.assertIn("jsonb_path_exists", schedule_sql)
        self.assertIn("JSONPATH", schedule_sql)
        self.assertIn("subjects.kind", schedule_sql)

    async def test_warning_reset_rejects_excess_before_mutating_review_or_reset_state(self):
        db = Database([(None,)] * 100)
        db.get = AsyncMock(return_value=None)
        await self.rejected(reset_subject_warnings(db, "p1", "admin", "Checked"), db)
        self.assertEqual(db.added, [])
        db.flush.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_complete_presence_rejects_excess_and_preserves_valid_entries(self):
        db = Database([(None, None)] * 100)
        admin = {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        await self.rejected(presence.get_presence_snapshot(db=db, actor=admin), db)
        now = datetime.now(timezone.utc)
        db = Database([(SimpleNamespace(subject_id="p1", state="inside",
            last_scan_timestamp=now, updated_at=now),
            SimpleNamespace(kind="employee", barcode="EMP-1"))])
        result = await presence.get_presence_snapshot(db=db, actor=admin)
        self.assertEqual((result[0].subject_id, result[0].barcode, result[0].state),
                         ("p1", "EMP-1", "inside"))

    async def test_terminal_rejects_unbounded_hardware_before_filtering_json(self):
        db = Database([(None, None, None)] * 100)
        with patch("routers.terminal.assigned_checkpoint", new=AsyncMock(return_value="cp-main")):
            await self.rejected(terminal.get_terminal_bundle(db=db, operator={"sub": "operator"}), db)

    async def test_employee_activity_rejects_excess_instead_of_returning_partial_hours(self):
        db = Database([], [(None, None)] * 100)
        await self.rejected(call_endpoint(employee_activity, subjectId="p1", db=db), db)
        self.assertEqual(db.queries[0]._limit_clause.value, 1)  # boundary seed

    async def test_employee_summary_bounds_employee_seed_and_range_sources(self):
        db = Database([(None,)] * 100)
        await self.rejected(call_endpoint(employee_activity_summary, db=db), db)
        db = Database([("p1",)], [(None, None, None)] * 100)
        await self.rejected(call_endpoint(employee_activity_summary, db=db), db)
        db = Database([("p1",)], [], [(None, None, None)] * 100)
        await self.rejected(call_endpoint(employee_activity_summary, db=db), db)

    async def test_movement_buckets_reject_excess_before_fetching_compatibility_sample(self):
        db = Database([(1,)], [(None, None)] * 100)
        await self.rejected(call_endpoint(movements.movement_analytics, db=db,
            actor={"sub": "admin", "realm_access": {"roles": ["admin"]}}), db)
        self.assertEqual(len(db.queries), 2)
        self.assertIn("GROUP BY date_trunc", str(db.queries[-1]))

    async def test_notes_read_and_write_reject_complete_reply_overflow_before_commit(self):
        for event_id, lookups, physical_id in (
                ("event", ["cp-main", "event"], "event"),
                (str(uuid.uuid4()), ["cp-main", None, "source-event"], "source-event")):
            with self.subTest(event_id=event_id):
                # Scalar lookups resolve the physical scan independently of
                # the complete, SQL-bounded note reply. Virtual hardware IDs
                # perform the additional source lookup before the same read.
                db = Database([("note",)] * 100)
                db.scalar = AsyncMock(side_effect=lookups)
                await self.rejected(movements.get_movement_notes(event_id, db=db,
                    actor={"sub": "admin", "realm_access": {"roles": ["admin"]}}), db)
                self.assertEqual(db.scalar.await_count, len(lookups))
                self.assertIn(physical_id, db.queries[-1].compile().params.values())

                db = Database([("note",)] * 100)
                db.scalar = AsyncMock(side_effect=lookups)
                await self.rejected(movements.add_movement_note(event_id,
                    movements.NoteRequest(note="new note"), db=db,
                    _admin={"sub": "admin", "realm_access": {"roles": ["admin"]}}), db)
                self.assertEqual(db.scalar.await_count, len(lookups))
                self.assertEqual(len(db.added), 1)
                self.assertEqual(db.added[0].event_id, physical_id)
                self.assertIn(physical_id, db.queries[-1].compile().params.values())
                db.flush.assert_awaited_once()
                db.commit.assert_not_awaited()

    async def test_empty_snapshots_keep_existing_complete_contracts(self):
        admin = {"sub": "admin", "realm_access": {"roles": ["admin"]}}
        registry_data = await registry.registry_bundle(db=Database(), actor=admin)
        self.assertEqual(set(registry_data), {"eventRevision", "people", "hardwareAssets", "alerts", "permissions",
            "movements", "auditEvents", "permissionRequests", "checkpoints"})
        self.assertEqual(registry_data.pop("eventRevision"), 0)
        self.assertTrue(all(value == [] for value in registry_data.values()))
        permission_data = await permissions.list_permissions(db=Database(), _admin=admin)
        self.assertEqual(set(permission_data), {"eventRevision", "people", "hardware", "requests", "subjects", "checkpoints"})
        self.assertEqual(permission_data.pop("eventRevision"), 0)
        self.assertTrue(all(value == [] for value in permission_data.values()))
        self.assertEqual((await list_alert_rule_assignments(Database()))["subjects"], [])

    async def test_browser_scan_passes_verified_request_scope_to_behavior_checks(self):
        db = Database()
        db.info["scan_replayed"] = True
        request = Request({"type": "http", "state": {"limit_identity": "browser:operator"}})
        payload = BrowserScanPayload(barcode="EMP-1", checkpointId="cp-main")
        receipt = {"allowed": True, "replayed": True}
        key = uuid.uuid4()
        with patch("routers.terminal.require_checkpoint", new=AsyncMock(return_value="cp-main")), \
             patch("routers.terminal.record_scan", new=AsyncMock(return_value=receipt)) as record:
            self.assertEqual(await terminal.scan(payload, key, db, {"sub": "operator"}, request=request), receipt)
        self.assertIs(record.await_args.kwargs["request_scope"], request.scope)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class DataQueryBoundsDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import test_database as fixtures
        await fixtures.DatabaseTests.asyncSetUp(self)
        from auth import verify_admin_request
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "bounds-admin", "realm_access": {"roles": ["admin"]}}

    async def asyncTearDown(self):
        import test_database as fixtures
        await fixtures.DatabaseTests.asyncTearDown(self)

    async def test_note_overflow_rolls_back_for_physical_and_projected_history_ids(self):
        from sqlalchemy import func
        from models import MovementNote
        from terminal_scans import record_scan
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            scan = await record_scan(db, uuid.uuid4(), BrowserScanPayload(
                barcode="p1", checkpointId="cp-main", selectedHardwareIds=["h1"]), "bounds-terminal")
            source_id = scan["decision"]["event"]["id"]
            db.add_all([MovementNote(event_id=source_id, note=f"note-{index}", created_at=now)
                for index in range(3)])
            await db.commit()
        hardware = await self.client.get("/v1/movements", params={"subjectGroup": "hardware"})
        self.assertEqual(hardware.status_code, 200, hardware.text)
        projected_id = hardware.json()["items"][0]["id"]
        self.assertNotEqual(source_id, projected_id)
        with patch.object(settings, "DATA_SNAPSHOT_MAX_ROWS", 3):
            for event_id in (source_id, projected_id):
                with self.subTest(event_id=event_id):
                    notes_url = f"/v1/movements/{event_id}/notes"
                    exact = await self.client.get(notes_url)
                    self.assertEqual(exact.status_code, 200, exact.text)
                    self.assertEqual(exact.json(), ["note-0", "note-1", "note-2"])
                    rejected = await self.client.post(notes_url, json={"note": "overflow"})
                    self.assertEqual(rejected.status_code, 422, rejected.text)
                    self.assertIn("complete read", rejected.json()["detail"])
                    async with self.sessions() as db:
                        self.assertEqual(await db.scalar(select(func.count()).select_from(MovementNote)), 3)

    async def test_sql_grouping_aggregates_full_alert_history_and_bucket_overflow_is_explicit(self):
        from datetime import timedelta
        from models import Alert, AlertRule
        from rule_engine import default_alert_rules
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            rule = next(rule for rule in default_alert_rules() if rule["id"] == "rule-irregularity")
            stored_rule = await db.get(AlertRule, rule["id"])
            if stored_rule is None:
                db.add(AlertRule(id=rule["id"], data=rule))
            else:
                stored_rule.data = rule
            db.add_all([Alert(id=f"trigger-{index}", created_at=now, data={
                "ruleId": rule["id"], "title": "Attendance irregularity", "subjectId": "p1"})
                for index in range(8)])
            db.add_all([Movement(id=f"bucket-{index}", subject_id="p1", checkpoint_id="cp-main",
                occurred_at=now - timedelta(hours=index), result="approved", direction="entry",
                scan_type="auto", subject_type="employee", sync_state="synced", data={})
                for index in range(4)])
            await db.commit()
        with patch.object(settings, "DATA_SNAPSHOT_MAX_ROWS", 3):
            alerts = await self.client.get("/v1/alerts", params={"limit": 2})
            self.assertEqual(alerts.status_code, 200, alerts.text)
            self.assertEqual(alerts.json()["total"], 8)
            rule = next(rule for rule in alerts.json()["rules"] if rule["id"] == "rule-irregularity")
            self.assertEqual(rule["recentTriggers"], 8)
            excess = await self.client.get("/v1/movements/analytics")
            self.assertEqual(excess.status_code, 422, excess.text)
            narrowed = await self.client.get("/v1/movements/analytics", params={"startAt": now.isoformat()})
            self.assertEqual(narrowed.status_code, 200, narrowed.text)
            self.assertEqual(narrowed.json()["summary"]["total"], 1)

    async def test_alert_directory_projects_names_counts_retained_history_and_rejects_excess_subjects(self):
        from sqlalchemy import event
        from models import AlertReview, Person
        now = datetime.now(timezone.utc)
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            person.data = {**person.data, "irrelevantLegacyBlob": "x" * 100_000}
            db.add_all([AlertReview(alert_id=f"retained-{index}", subject_id="p1", decision="confirmed",
                reason="Checked", reviewed_at=now, reviewed_by="admin", alert_created_at=now,
                alert_data={"id": f"retained-{index}", "title": "Attendance irregularity", "status": "warned"})
                for index in range(8)])
            await db.commit()
        queries = []
        def capture(_connection, _cursor, statement, _parameters, _context, _many):
            queries.append(statement)
        event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
        try:
            with patch.object(settings, "DATA_SNAPSHOT_MAX_ROWS", 3):
                result = await self.client.get("/v1/alerts", params={"limit": 1})
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json()["total"], 8)
                warning = next(item for item in result.json()["warnings"] if item["subjectId"] == "p1")
                self.assertEqual((warning["subjectName"], warning["count"]), ("Alice", 8))
                self.assertFalse(any("people.data AS people_data" in query for query in queries))
                async with self.sessions() as db:
                    db.add_all([Subject(id=f"extra-{index}", kind="employee", barcode=f"EXTRA-{index}")
                        for index in range(2)])
                    await db.commit()
                rejected = await self.client.get("/v1/alerts", params={"limit": 1})
                self.assertEqual(rejected.status_code, 422, rejected.text)
                self.assertIn("complete read", rejected.json()["detail"])
                self.assertNotIn("warnings", rejected.json())
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", capture)


if __name__ == "__main__":
    unittest.main()
