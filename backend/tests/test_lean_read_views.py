"""Opt-in compact reads skip work while retaining legacy response defaults."""
import inspect
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.params import Param
from alert_reviews import warning_directory
from registry_reads import registry_page
from routers import alerts, movements


class LeanReadViewTests(unittest.IsolatedAsyncioTestCase):
    async def test_registry_overview_reuses_activity_without_changing_overnight_hours_or_breaks(self):
        now = datetime(2026, 11, 6, 7, 30, tzinfo=timezone.utc)
        midnight = datetime(2026, 11, 5, 18, 30, tzinfo=timezone.utc)
        before = midnight - timedelta(hours=1)
        events = [
            ("entry", before), ("exit", before), ("entry", before),
            ("exit", midnight + timedelta(hours=1)),
            ("entry", midnight + timedelta(hours=2)),
            ("exit", midnight + timedelta(hours=5)),
        ]
        subject = SimpleNamespace(id="employee-1", kind="employee", barcode="EMP-1",
            person=SimpleNamespace(data={"name": "Alice", "allowedZones": ["a"]}), hardware=None,
            presence_state=None)

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return now.astimezone(tz)

        async def read_transitions(_db, ids, start, end, *, zone_ids):
            self.assertEqual(zone_ids, ["a"])
            preceding = [event for event in events if event[1] < start]
            window = preceding[-1:] + [event for event in events if start <= event[1] <= end]
            return {subject_id: window if subject_id == subject.id else [] for subject_id in ids}

        async def read(include_overview):
            records, empty, counters = MagicMock(), MagicMock(), MagicMock()
            records.all.return_value = [subject]
            empty.all.return_value = []
            counters.mappings.return_value.one.return_value = {"total": 2, "inside": 0}
            db = SimpleNamespace(scalar=AsyncMock(return_value=2), scalars=AsyncMock(side_effect=[records, empty, empty]),
                execute=AsyncMock(return_value=counters))
            with patch("registry_reads.datetime", FixedDateTime), \
                 patch("registry_reads.entry_restrictions_for_subjects", new=AsyncMock(return_value={})), \
                 patch("registry_reads.bounded_rows", new=AsyncMock(return_value=[("employee-1",), ("employee-2",)])), \
                 patch("registry_reads.employee_activity_rows", new=AsyncMock(side_effect=read_transitions)) as activity:
                result = await registry_page(db, kind="employee", limit=1, offset=0, search=None, days=1,
                    sort_key="name", sort_direction="asc", include_overview=include_overview, zone_ids=["a"])
            activity.assert_awaited_once()
            expected_ids = ["employee-1", "employee-2"] if include_overview else ["employee-1"]
            self.assertEqual(activity.await_args.args[1], expected_ids)
            return result

        page = await read(False)
        overview = await read(True)
        self.assertEqual(overview["activityDays"], page["activityDays"])
        self.assertEqual(overview["averages"], {"employee-1": 4.0})
        self.assertEqual(overview["activityDays"]["employee-1"][0]["sessions"], [
            {"start": 0, "end": 1, "type": "work", "zIndex": 1},
            {"start": 1, "end": 2, "type": "break", "zIndex": 2},
            {"start": 2, "end": 5, "type": "work", "zIndex": 1},
        ])
        self.assertEqual(overview["summary"]["total"], 2)
        self.assertIn("trend", overview)

    async def test_alert_item_read_skips_catalog_and_trigger_queries_without_changing_items(self):
        now = datetime(2026, 11, 5, tzinfo=timezone.utc)
        item = {"id": "alert-1", "title": "No break recorded", "warningCount": 2,
            "review": {"decision": "confirmed"}, "entryRestriction": {"active": True}}
        async def read(include_rules):
            count = MagicMock()
            count.scalar_one.return_value = 1
            page = MagicMock()
            page.mappings.return_value.all.return_value = [{"id": "alert-1", "created_at": now, "data": item}]
            db = SimpleNamespace(execute=AsyncMock(side_effect=[count, page]))
            arguments = {name: parameter.default.default for name, parameter in inspect.signature(alerts.list_alerts).parameters.items()
                if isinstance(parameter.default, Param)}
            with patch("routers.alerts.admin_zone_ids", new=AsyncMock(return_value=["a"])), \
                 patch("event_outbox.read_event_revision", new=AsyncMock(return_value=3)), \
                 patch("routers.alerts.enrich_alert_documents", new=AsyncMock(return_value={"items": [item], "warnings": []})), \
                 patch("routers.alerts.alert_rule_catalog", new=AsyncMock(return_value=[{"id": "rule-1"}])) as catalog, \
                 patch("routers.alerts.bounded_rows", new=AsyncMock(return_value=[])) as grouped:
                result = await alerts.list_alerts(**{**arguments, "db": db, "actor": {}, "includeRules": include_rules})
            return result, catalog.await_count, grouped.await_count
        full, catalogs, grouped = await read(True)
        compact, lean_catalogs, lean_grouped = await read(False)
        self.assertEqual(compact, {**full, "rules": []})
        self.assertEqual((catalogs, grouped, lean_catalogs, lean_grouped), (1, 1, 0, 0))

    async def test_registry_export_keeps_employee_averages_and_skips_latest_and_checkpoint_reads(self):
        subject = SimpleNamespace(id="employee-1", kind="employee", barcode="EMP-1",
            person=SimpleNamespace(data={"name": "Alice", "allowedZones": ["a"]}), hardware=None,
            presence_state=SimpleNamespace(state="inside"))
        async def read(include_related):
            records = MagicMock()
            records.all.return_value = [subject]
            empty = MagicMock()
            empty.all.return_value = []
            db = SimpleNamespace(scalar=AsyncMock(return_value=1), scalars=AsyncMock(side_effect=[records, empty, empty]))
            with patch("registry_reads.entry_restrictions_for_subjects", new=AsyncMock(return_value={})), \
                 patch("registry_reads.employee_activity_rows", new=AsyncMock(return_value={"employee-1": [("entry", datetime.now(timezone.utc))]})), \
                 patch("registry_reads.build_activity_days", return_value=[{"date": "2026-11-05", "workedHours": 6, "sessions": []}]):
                result = await registry_page(db, kind="employee", limit=25, offset=0, search=None, days=1,
                    sort_key="name", sort_direction="asc", include_overview=False, zone_ids=["a"], include_related=include_related)
            return result, db.scalars.await_count
        full, full_queries = await read(True)
        compact, compact_queries = await read(False)
        self.assertEqual(compact["people"], full["people"])
        self.assertEqual(compact["averages"], {"employee-1": 6})
        self.assertEqual(compact["averages"], full["averages"])
        self.assertEqual(compact["activityDays"], {})
        self.assertEqual(full_queries - compact_queries, 2)

    async def test_movement_export_skips_notes_without_changing_ledger_item_fields(self):
        now = datetime(2026, 11, 5, tzinfo=timezone.utc)
        event = SimpleNamespace(id="event-1", subject_id="p1", checkpoint_id="cp-main", occurred_at=now,
            denial_code=None, result="approved", direction="entry", scan_type="auto", subject_type="employee",
            sync_state="synced", data={"subjectName": "Alice", "reason": "Allowed", "sourceEventId": "event-1"})
        async def read(include_notes):
            count, page = MagicMock(), MagicMock()
            count.scalar_one.return_value = 1
            page.scalars.return_value.all.return_value = [event]
            db = SimpleNamespace(execute=AsyncMock(side_effect=[count, page]))
            arguments = {name: parameter.default.default for name, parameter in inspect.signature(movements.list_movements).parameters.items()
                if isinstance(parameter.default, Param)}
            with patch("routers.movements.admin_zone_ids", new=AsyncMock(return_value=["a"])), \
                 patch("routers.movements.bounded_rows", new=AsyncMock(return_value=[("event-1", "Verified")])) as notes:
                result = await movements.list_movements(**{**arguments, "db": db, "actor": {}, "subjectGroup": "people", "includeNotes": include_notes})
            return result, notes.await_count
        full, full_notes = await read(True)
        compact, compact_notes = await read(False)
        self.assertEqual(compact, {**full, "movementNotes": {}})
        self.assertEqual((full_notes, compact_notes), (1, 0))

    async def test_bucket_only_analytics_skips_sample_query_and_preserves_aggregates(self):
        async def read(include_sample):
            now = datetime(2026, 11, 5, tzinfo=timezone.utc)
            summary = MagicMock()
            summary.mappings.return_value.one.return_value = {"total": 7, "approved": 5, "denied": 2}
            checkpoints = MagicMock()
            checkpoints.scalars.return_value.all.return_value = []
            sample = MagicMock()
            sample.scalars.return_value.all.return_value = [SimpleNamespace(data={"subjectName": "Alice"},
                id="event-1", sync_state="synced", occurred_at=now)]
            db = SimpleNamespace(execute=AsyncMock(side_effect=[summary, *([sample] if include_sample else []), checkpoints]))
            arguments = {name: parameter.default.default for name, parameter in inspect.signature(movements.movement_analytics).parameters.items()
                if isinstance(parameter.default, Param)}
            buckets = [SimpleNamespace(_mapping={"bucket": now, "count": 7})]
            with patch("routers.movements.admin_zone_ids", new=AsyncMock(return_value=["a"])), \
                 patch("routers.movements.bounded_rows", new=AsyncMock(return_value=buckets)):
                result = await movements.movement_analytics(**{**arguments, "db": db, "actor": {}, "includeSample": include_sample})
            return result, db.execute.await_count
        full, full_queries = await read(True)
        compact, compact_queries = await read(False)
        self.assertEqual(compact, {**full, "items": []})
        self.assertEqual((len(full["items"]), full_queries - compact_queries), (1, 1))

    async def test_empty_focused_alert_directory_does_not_scan_warning_history(self):
        with patch("alert_reviews.bounded_rows", new=AsyncMock(return_value=[])) as fetch, \
             patch("alert_reviews.entry_restrictions_for_subjects", new=AsyncMock()) as restrictions:
            self.assertEqual(await warning_directory(object(), subject_ids=[]), ([], {}, {}, {}, {}))
        self.assertEqual(fetch.await_count, 1)
        restrictions.assert_not_awaited()
