"""Narrow attendance reads preserve irregularity identity and deduplication rules."""
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import Person, Subject
from movement_logic import _current_date, _current_time
from rule_engine import build_workday_statuses, default_alert_rules, evaluate_scheduled_rules
from workflows import activities


NOW = datetime(2026, 10, 9, 14, tzinfo=timezone.utc)


def rows(values):
    return SimpleNamespace(all=lambda: list(values))


class AlertEvaluationProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def evaluate(self, existing):
        people = [{"id": identity, "barcode": identity, "name": identity.title(), "type": "employee", "status": "active"}
            for identity in ("alice", "bob", "carol")]
        specs = (("alice", "approved", "entry", "employee", 8),
            ("bob", "denied", "entry", "employee", 1),
            ("carol", "approved", "entry", "employee", 10),
            ("carol", "approved", "exit", "employee", 8),
            ("carol", "approved", "entry", "employee", 7),
            ("visitor", "approved", "entry", "visitor", 9),
            ("asset", "approved", "entry", "hardware", 9))
        projected, legacy = [], []
        for subject, result, direction, kind, hours in specs:
            at = NOW - timedelta(hours=hours)
            canonical = {"subjectId": subject, "result": result, "direction": direction,
                "subjectType": kind, "createdAt": at.isoformat(), "date": _current_date(at), "time": _current_time(at)}
            projected.append(SimpleNamespace(subject_id=subject, result=result, direction=direction, subject_type=kind, occurred_at=at))
            legacy.append({"id": subject + str(hours), "subjectId": "stale-json-identity", "result": "stale-json-result",
                "hardwareSnapshots": [{"barcode": "irrelevant", "metadata": "x" * 10000}], **canonical})
        catalog = default_alert_rules()
        expected = evaluate_scheduled_rules(catalog, legacy, build_workday_statuses(legacy, people, now=NOW),
            existing, employees=people, now=NOW)
        person_rows = [(Person(data=person), Subject(id=person["id"], barcode=person["barcode"], kind="employee"))
            for person in people]
        execute_results = iter([rows(projected), rows(person_rows), rows([]),
            rows(projected), rows(person_rows), rows([])])
        def execute_result(_query):
            return next(execute_results)

        page_reads = 0
        def scalars_result(query):
            nonlocal page_reads
            sql = str(query).lower()
            selected = list(query.selected_columns)
            if "alert_rule_assignments" in sql:
                return rows([])
            if "from subjects" in sql:
                if getattr(query, "_for_update_arg", None) is not None:
                    return rows(["bob"])
                page_reads += 1
                return rows(["alice", "bob", "carol", "visitor", "asset"] if page_reads == 1 else [])
            if "from alerts" in sql:
                return rows(existing if selected and selected[0].name == "data" else [])
            return rows([])

        db = SimpleNamespace(scalar=AsyncMock(return_value=True),
            execute=AsyncMock(side_effect=execute_result),
            scalars=AsyncMock(side_effect=scalars_result),
            commit=AsyncMock(), add=Mock())
        captured = []

        @asynccontextmanager
        async def sessions():
            yield db

        def evaluate_without_writing(rules, movements, workdays, history, **kwargs):
            captured.extend(evaluate_scheduled_rules(rules, movements, workdays, history, **kwargs))
            return []  # This unit check exercises the complete optimistic read.

        with patch.object(activities, "async_session", sessions), \
             patch.object(activities, "datetime", wraps=datetime) as clock, \
             patch("alert_rule_assignments.alert_rule_catalog", new=AsyncMock(return_value=catalog)), \
             patch("rule_engine.evaluate_scheduled_rules", side_effect=evaluate_without_writing):
            clock.now.return_value = NOW
            self.assertEqual(await activities.run_alert_rule_evaluation(), 0)
        self.assertEqual(captured, expected)
        movement_query = db.execute.await_args_list[0].args[0]
        self.assertEqual({column.name for column in movement_query.selected_columns},
            {"subject_id", "result", "direction", "subject_type", "occurred_at"})
        self.assertIsNotNone(movement_query._limit_clause)
        history_query = next(call.args[0] for call in db.scalars.await_args_list
            if list(call.args[0].selected_columns)[0].name == "data")
        self.assertEqual([column.name for column in history_query.selected_columns], ["data"])
        db.commit.assert_awaited_once()
        db.add.assert_not_called()
        return captured

    async def test_projected_movement_columns_drive_irregularity_without_workday_no_breaks(self):
        alerts = await self.evaluate([])
        self.assertEqual({(alert["subjectId"], alert["conditionKey"]) for alert in alerts},
            {("bob", "irregularity")})

    async def test_json_only_alert_history_keeps_legacy_identity_deduplication(self):
        rules = {rule["conditionKey"]: rule["id"] for rule in default_alert_rules()}
        alerts = await self.evaluate([{"id": "AL-2026-0042", "ruleId": rules["no_break"],
            "barcode": "alice", "date": _current_date(NOW)}])
        self.assertEqual([(alert["subjectId"], alert["conditionKey"]) for alert in alerts], [("bob", "irregularity")])
        self.assertEqual(alerts[0]["id"], "AL-2026-0043")


if __name__ == "__main__":
    unittest.main()
