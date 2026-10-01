import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rule_engine import (  # noqa: E402
    build_workday_statuses,
    default_alert_rules,
    evaluate_scheduled_rules,
    with_default_alert_rules,
)


class RuleEngineTests(unittest.TestCase):
    def test_default_rules_only_include_supported_conditions(self):
        rules = default_alert_rules()
        self.assertEqual({rule["id"] for rule in rules}, {"rule-no-break", "rule-irregularity"})
        self.assertEqual({rule["conditionKey"] for rule in rules}, {"no_break", "irregularity"})

        legacy = [
            {"id": "rule-exit-balance", "conditionKey": "exit_balance", "enabled": True},
            {"id": "rule-no-break", "conditionKey": "no_break", "enabled": True},
        ]
        normalized = with_default_alert_rules(legacy)
        self.assertEqual({rule["conditionKey"] for rule in normalized}, {"no_break", "irregularity"})

    def test_irregularity_alerts_active_employee_missing_entry_after_cutoff(self):
        now = datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc)  # 7:00 PM IST
        employees = [
            {"id": "absent", "barcode": "EMP-ABSENT", "name": "Absent", "type": "employee", "status": "active"},
            {"id": "present", "barcode": "EMP-PRESENT", "name": "Present", "type": "employee", "status": "active"},
            {"id": "inactive", "barcode": "EMP-INACTIVE", "name": "Inactive", "type": "employee", "status": "inactive"},
            {"id": "visitor", "barcode": "VIS-1", "name": "Visitor", "type": "visitor", "status": "active"},
        ]
        movements = [{
            "id": "entry-1",
            "subjectId": "present",
            "subjectType": "employee",
            "direction": "entry",
            "result": "approved",
            "date": "Sep 29, 2026",
        }]

        generated = evaluate_scheduled_rules(
            [{"id": "rule-irregularity", "conditionKey": "irregularity", "enabled": True}],
            movements,
            [],
            [],
            employees=employees,
            now=now,
        )

        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0]["subjectName"], "Absent")
        self.assertEqual(generated[0]["barcode"], "EMP-ABSENT")
        self.assertEqual(generated[0]["category"], "presence_anomaly")

    def test_irregularity_waits_until_attendance_cutoff_and_is_deduplicated(self):
        now = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)  # 5:30 PM IST
        employee = {"id": "p1", "barcode": "EMP-1", "name": "Alice", "type": "employee", "status": "active"}
        rule = {"id": "rule-irregularity", "conditionKey": "irregularity", "enabled": True}

        self.assertEqual(
            evaluate_scheduled_rules([rule], [], [], [], employees=[employee], now=now),
            [],
        )
        first = evaluate_scheduled_rules(
            [rule], [], [], [], employees=[employee], now=now.replace(hour=13, minute=0)
        )
        second = evaluate_scheduled_rules(
            [rule], [], [], first, employees=[employee], now=now.replace(hour=13, minute=5)
        )
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_open_shift_is_counted_for_workday_and_no_break_alert(self):
        now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)  # 5:30 PM IST
        employee = {
            "id": "p1",
            "barcode": "EMP-1",
            "name": "Alice",
            "type": "employee",
            "status": "active",
        }
        movements = [{
            "id": "entry-1",
            "subjectId": "p1",
            "subjectType": "employee",
            "direction": "entry",
            "result": "approved",
            "date": "Oct 1, 2026",
            "time": "10:30:00 AM",
            "createdAt": "2026-10-01T05:00:00+00:00",
        }]

        workdays = build_workday_statuses(movements, [employee], now=now)
        self.assertEqual(workdays[0]["minutesInside"], 420)
        self.assertFalse(workdays[0]["shiftEnded"])

        generated = evaluate_scheduled_rules(
            [{"id": "rule-no-break", "conditionKey": "no_break", "enabled": True}],
            movements,
            workdays,
            [],
            employees=[employee],
            now=now,
        )
        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0]["conditionKey"], "no_break")
        self.assertEqual(generated[0]["subjectId"], "p1")

if __name__ == "__main__":
    unittest.main()
