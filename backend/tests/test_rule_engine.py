import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rule_engine import (  # noqa: E402
    build_workday_statuses,
    default_alert_rules,
    eligible_alert_subject_types,
    evaluate_scheduled_rules,
    with_default_alert_rules,
)


class RuleEngineTests(unittest.TestCase):
    def test_assignment_eligibility_never_offers_hardware_or_retired_conditions(self):
        for rule in default_alert_rules():
            self.assertEqual(eligible_alert_subject_types(rule), ("employee",))
            self.assertEqual(eligible_alert_subject_types({**rule, "enabled": False}), ("employee",))
        for rule in (
            {"id": "rule-no-break", "conditionKey": "unauthorized_hardware_carrier"},
            {"id": "rule-exit-balance", "conditionKey": "no_break"},
            {"id": "rule-manual-review", "conditionKey": "manual_review"},
            {"id": "unknown", "conditionKey": "not_implemented"},
        ):
            self.assertEqual(eligible_alert_subject_types(rule), ())

    def test_complete_assignments_filter_both_conditions_and_default_subjects_inherit(self):
        now = datetime(2026, 10, 7, 13, 0, tzinfo=timezone.utc)
        employees = [{"id": subject_id, "name": subject_id, "barcode": subject_id, "type": "employee"}
                     for subject_id in ("default", "none", "break-only", "attendance-only")]
        workdays = [{"employeeId": employee["id"], "employeeName": employee["name"], "date": "Oct 6, 2026",
                     "breakMinutes": 0, "minutesInside": 420, "shiftEnded": True} for employee in employees]
        assignments = {"none": [], "break-only": ["rule-no-break"], "attendance-only": ["rule-irregularity"]}
        generated = evaluate_scheduled_rules(default_alert_rules(), [], workdays, [],
            employees=employees, now=now, rule_assignments=assignments)
        self.assertEqual({(alert["subjectId"], alert["ruleId"]) for alert in generated}, {
            ("default", "rule-no-break"), ("default", "rule-irregularity"),
            ("break-only", "rule-no-break"), ("attendance-only", "rule-irregularity"),
        })

    def test_assigned_inactive_rules_stay_inactive_and_reselection_preserves_dedup(self):
        now = datetime(2026, 10, 7, 13, 0, tzinfo=timezone.utc)
        employee = {"id": "p1", "name": "Alice", "barcode": "EMP-1", "type": "employee"}
        rule = {"id": "rule-irregularity", "conditionKey": "irregularity", "enabled": False}
        assignments = {"p1": ["rule-irregularity"]}
        self.assertEqual(evaluate_scheduled_rules([rule], [], [], [], employees=[employee], now=now,
            rule_assignments=assignments), [])
        rule["enabled"] = True
        first = evaluate_scheduled_rules([rule], [], [], [], employees=[employee], now=now, rule_assignments=assignments)
        self.assertEqual(len(first), 1)
        self.assertEqual(evaluate_scheduled_rules([rule], [], [], first, employees=[employee], now=now,
            rule_assignments={"p1": []}), [])
        self.assertEqual(evaluate_scheduled_rules([rule], [], [], first, employees=[employee], now=now,
            rule_assignments=assignments), [])

    def test_custom_selection_can_choose_an_existing_rule_of_the_same_condition(self):
        rules = [{"id": "default-attendance", "conditionKey": "irregularity", "enabled": True},
                 {"id": "alternate-attendance", "conditionKey": "irregularity", "enabled": True, "severity": "high"}]
        employee = {"id": "p1", "name": "Alice", "type": "employee"}
        generated = evaluate_scheduled_rules(rules, [], [], [], employees=[employee],
            now=datetime(2026, 10, 7, 13, 0, tzinfo=timezone.utc), rule_assignments={"p1": ["alternate-attendance"]})
        self.assertEqual([(alert["ruleId"], alert["severity"]) for alert in generated], [("alternate-attendance", "high")])

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
        now = datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc)  # 7:00 PM (Asia/Kolkata)
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
        now = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)  # 5:30 PM (Asia/Kolkata)
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
        now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)  # 5:30 PM (Asia/Kolkata)
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

    def test_critical_no_break_alert_binds_real_barcode_and_deduplicates_by_identity(self):
        now = datetime(2026, 10, 6, 13, 0, tzinfo=timezone.utc)
        rule = {"id": "rule-no-break", "conditionKey": "no_break", "enabled": True, "severity": "critical"}
        employee = {"id": "p2", "barcode": "EMP-2", "name": "Same name", "type": "employee"}
        workday = {"employeeId": "p2", "employeeName": "Same name", "breakMinutes": 0,
            "minutesInside": 420, "date": "Oct 6, 2026"}
        existing = {"ruleId": "rule-no-break", "subjectId": "p1", "subjectName": "Same name", "date": workday["date"]}
        generated = evaluate_scheduled_rules([rule], [], [workday], [existing], employees=[employee], now=now)
        self.assertEqual(len(generated), 1)
        self.assertEqual((generated[0]["subjectId"], generated[0]["barcode"], generated[0]["severity"]), ("p2", "EMP-2", "critical"))
        self.assertEqual(evaluate_scheduled_rules([rule], [], [workday], generated, employees=[employee], now=now), [])

if __name__ == "__main__":
    unittest.main()
