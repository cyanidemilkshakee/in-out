"""Complete rule selections preserve inheritance, audit evidence and worker ordering."""
import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, event, func, select

import test_database as database_fixture
from alert_rule_assignments import (AlertRuleAssignmentInput, replace_alert_rule_assignment,
    validate_selected_rules)
from auth import verify_admin_request
from models import (Alert, AlertRule, AlertRuleAssignment, AuditEvent, CriticalEntryRestriction,
    HardwareAsset, Person, Subject)
from rule_engine import default_alert_rules


class AlertRuleAssignmentValidationTests(unittest.TestCase):
    def test_complete_selection_and_revision_reject_coercion_extra_fields_and_prototype_ids(self):
        self.assertEqual(AlertRuleAssignmentInput(ruleIds=[], expectedRevision=0).ruleIds, [])
        for body in ({}, {"ruleIds": None}, {"ruleIds": "rule-no-break"}, {"ruleIds": [True]},
                     {"ruleIds": [" "]}, {"ruleIds": ["__proto__"]}, {"ruleIds": ["constructor"]},
                     {"ruleIds": ["prototype"]}, {"ruleIds": ["rule-no-break", "rule-no-break"]},
                     {"ruleIds": [], "expectedRevision": True}, {"ruleIds": [], "expectedRevision": "0"},
                     {"ruleIds": [], "expectedRevision": -1}, {"ruleIds": [], "expectedRevision": 0.5},
                     {"ruleIds": [], "enabled": True}, {"ruleIds": [], "__proto__": {"role": "admin"}}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                AlertRuleAssignmentInput.model_validate(body)

    def test_inactive_rules_are_assignable_but_hardware_visitors_and_unknown_rules_are_ineligible(self):
        rules = [{**rule, "enabled": False, "eligibleSubjectTypes": ["employee"]} for rule in default_alert_rules()]
        self.assertEqual(validate_selected_rules("employee", ["rule-no-break"], rules), ["rule-no-break"])
        self.assertEqual(validate_selected_rules("hardware", [], rules), [])
        for subject_type, ids in (("hardware", ["rule-no-break"]), ("visitor", []),
                                  ("employee", ["rule-unauthorized-hardware"]), ("employee", ["not-registered"]),
                                  ("employee", ["__proto__"]), ("employee", [True])):
            with self.subTest(subject_type=subject_type, ids=ids), self.assertRaises(HTTPException) as error:
                validate_selected_rules(subject_type, ids, rules)
            self.assertEqual(error.exception.status_code, 422)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class AlertRuleAssignmentDatabaseTests(unittest.IsolatedAsyncioTestCase):
    # This fixture applies the complete Alembic chain in a fresh schema.
    asyncSetUp = database_fixture.DatabaseTests.asyncSetUp
    asyncTearDown = database_fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "assignment-admin"}

    async def save(self, subject_id, ids, revision=None):
        body = {"ruleIds": ids}
        if revision is not None:
            body["expectedRevision"] = revision
        with patch("routers.alerts.publish_data_changed", new=AsyncMock()):
            return await self.client.put(f"/v1/alert-rule-assignments/{subject_id}", json=body)

    async def seed_rule(self, rule_id="rule-irregularity", **changes):
        data = next(rule for rule in default_alert_rules() if rule["id"] == rule_id)
        async with self.sessions() as db:
            row = await db.get(AlertRule, rule_id)
            if row:
                row.data = {**data, **changes}
            else:
                db.add(AlertRule(id=rule_id, data={**data, **changes}))
            await db.commit()

    async def test_directory_uses_registered_kinds_and_canonical_rule_ids_with_default_inheritance(self):
        self.authorize()
        await self.seed_rule("rule-no-break", id="forged-rule-id", enabled=False)
        async with self.sessions() as db:
            db.add(Subject(id="visitor", kind="visitor", barcode="VIS-1",
                person=Person(data={"id": "p1", "type": "employee", "name": "Visitor"})))
            (await db.get(HardwareAsset, "h1")).data = {"id": "p1", "type": "employee", "name": "Laptop"}
            db.add_all([
                AlertRule(id="retired", data={"conditionKey": "unauthorized_hardware_carrier", "enabled": True}),
                AlertRule(id="not-implemented", data={"conditionKey": "invented", "enabled": True}),
            ])
            await db.commit()
        response = await self.client.get("/v1/alert-rule-assignments")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual({rule["id"] for rule in data["rules"]}, {"rule-no-break", "rule-irregularity"})
        self.assertTrue(all(rule["eligibleSubjectTypes"] == ["employee"] for rule in data["rules"]))
        self.assertFalse(next(rule for rule in data["rules"] if rule["id"] == "rule-no-break")["enabled"])
        rows = {row["subjectId"]: row for row in data["subjects"]}
        self.assertEqual(set(rows), {"p1", "h1"})
        self.assertEqual(rows["p1"]["ruleIds"], ["rule-irregularity", "rule-no-break"])
        self.assertEqual((rows["p1"]["source"], rows["p1"]["revision"]), ("default", 0))
        self.assertEqual((rows["h1"]["subjectType"], rows["h1"]["barcode"], rows["h1"]["ruleIds"]), ("hardware", "h1", []))
        saved = await self.save("p1", ["rule-no-break"], 0)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["ruleIds"], ["rule-no-break"])

    async def test_empty_override_is_durable_and_audited_without_changing_global_rules(self):
        self.authorize()
        async with self.sessions() as db:
            before = {rule.id: rule.data for rule in (await db.scalars(select(AlertRule))).all()}
        result = await self.save("p1", [], 0)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((result.json()["ruleIds"], result.json()["source"], result.json()["revision"]), ([], "custom", 1))
        async with self.sessions() as db:
            assignment = await db.get(AlertRuleAssignment, "p1")
            self.assertEqual((assignment.rule_ids, assignment.updated_by), ([], "assignment-admin"))
            self.assertEqual({rule.id: rule.data for rule in (await db.scalars(select(AlertRule))).all()}, before)
            audit = await db.scalar(select(AuditEvent))
            self.assertEqual((audit.data["category"], audit.data["subjectId"], audit.data["actor"]), ("alert", "p1", "assignment-admin"))
            self.assertEqual(audit.data["previousRuleIds"], ["rule-irregularity", "rule-no-break"])
            self.assertEqual(audit.data["ruleIds"], [])
        directory = (await self.client.get("/v1/alert-rule-assignments")).json()
        self.assertEqual(next(row for row in directory["subjects"] if row["subjectId"] == "p1")["ruleIds"], [])

    async def test_identical_retry_is_idempotent_but_stale_different_selection_conflicts(self):
        self.authorize()
        with patch("routers.alerts.publish_data_changed", new=AsyncMock()) as publish:
            first = await self.client.put("/v1/alert-rule-assignments/p1", json={"ruleIds": ["rule-no-break", "rule-irregularity"], "expectedRevision": 0})
            retry = await self.client.put("/v1/alert-rule-assignments/p1", json={"ruleIds": ["rule-irregularity", "rule-no-break"], "expectedRevision": 0})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        publish.assert_awaited_once()
        stale = await self.save("p1", [], 0)
        self.assertEqual(stale.status_code, 409, stale.text)
        changed = await self.save("p1", [], 1)
        self.assertEqual(changed.json()["revision"], 2)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 2)

    async def test_invalid_selections_refuse_unknown_subjects_visitors_hardware_and_forged_ids(self):
        self.authorize()
        async with self.sessions() as db:
            db.add(Subject(id="visitor", kind="visitor", barcode="VIS-1", person=Person(data={"name": "Guest"})))
            await db.commit()
        for subject_id, ids, status in (("missing", [], 404), ("visitor", [], 422),
            ("h1", ["rule-no-break"], 422), ("p1", ["rule-unauthorized-hardware"], 422),
            ("p1", ["unknown"], 422), ("p1", ["__proto__"], 422),
            ("p1", ["rule-no-break", "rule-no-break"], 422), ("p1", [True], 422)):
            with self.subTest(subject_id=subject_id, ids=ids):
                response = await self.save(subject_id, ids, 0)
                self.assertEqual(response.status_code, status, response.text)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AlertRuleAssignment)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 0)

    async def test_assignment_reads_and_writes_require_admin(self):
        self.assertEqual((await self.client.get("/v1/alert-rule-assignments")).status_code, 401)
        self.assertEqual((await self.client.put("/v1/alert-rule-assignments/p1", json={"ruleIds": []})).status_code, 401)
        with patch("auth.verify_keycloak_token", return_value={"sub": "operator", "realm_access": {"roles": ["operator"]}}):
            headers = {"Authorization": "Bearer synthetic-operator"}
            self.assertEqual((await self.client.get("/v1/alert-rule-assignments", headers=headers)).status_code, 403)
            self.assertEqual((await self.client.put("/v1/alert-rule-assignments/p1", json={"ruleIds": []}, headers=headers)).status_code, 403)

    async def test_commit_survives_publication_failure_and_rollback_removes_assignment_and_audit(self):
        self.authorize()
        with patch("routers.alerts.publish_data_changed", new=AsyncMock(side_effect=RuntimeError("publication unavailable"))):
            response = await self.client.put("/v1/alert-rule-assignments/p1", json={"ruleIds": [], "expectedRevision": 0})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(AlertRuleAssignment, "p1")).rule_ids, [])
            original_flush = db.flush
            async def fail_after_flush():
                await original_flush()
                raise RuntimeError("failure after database writes")
            with patch.object(db, "flush", new=AsyncMock(side_effect=fail_after_flush)):
                with self.assertRaises(RuntimeError):
                    await replace_alert_rule_assignment(db, "p1", ["rule-no-break"], "other-admin", 1)
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(AlertRuleAssignment, "p1")).rule_ids, [])
            self.assertEqual(await db.scalar(select(func.count()).select_from(AuditEvent)), 1)

    async def test_directory_query_count_is_bounded_as_registered_subject_count_grows(self):
        self.authorize()
        async with self.sessions() as db:
            db.add_all([Subject(id=f"employee-{index}", kind="employee", barcode=f"EMP-{index}",
                person=Person(data={"name": f"Employee {index}"})) for index in range(30)])
            await db.commit()
        statements = []
        def record_query(_conn, _cursor, statement, _parameters, _context, _executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)
        event.listen(self.engine.sync_engine, "before_cursor_execute", record_query)
        try:
            response = await self.client.get("/v1/alert-rule-assignments")
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", record_query)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["subjects"]), 32)
        self.assertLessEqual(len(statements), 4, "Rule directory reads must not perform a query for every subject")

    async def test_assignment_cascades_only_with_a_deletable_subject_and_keeps_audit_evidence(self):
        self.authorize()
        async with self.sessions() as db:
            db.add(Subject(id="unused", kind="employee", barcode="UNUSED", person=Person(data={"name": "Unused"})))
            await db.commit()
        self.assertEqual((await self.save("unused", [], 0)).status_code, 200)
        async with self.sessions() as db:
            await db.execute(delete(Subject).where(Subject.id == "unused"))
            await db.commit()
        async with self.sessions() as db:
            self.assertIsNone(await db.get(AlertRuleAssignment, "unused"))
            self.assertEqual((await db.scalar(select(AuditEvent))).data["subjectId"], "unused")

    async def test_worker_filters_custom_selection_before_alerts_restrictions_and_dedup(self):
        from workflows.activities import run_alert_rule_evaluation
        self.authorize()
        await self.seed_rule(severity="critical")
        self.assertEqual((await self.save("p1", [], 0)).status_code, 200)
        fixed_now = datetime(2026, 10, 7, 13, 0, tzinfo=timezone.utc)
        with patch("workflows.activities.async_session", new=self.sessions), \
             patch("workflows.activities.publish_presence_update", new=AsyncMock()) as publish, \
             patch("workflows.activities.datetime", wraps=datetime) as clock:
            clock.now.return_value = fixed_now
            self.assertEqual(await run_alert_rule_evaluation(), 0)
            publish.assert_not_awaited()
            self.assertEqual((await self.save("p1", ["rule-irregularity"], 1)).status_code, 200)
            self.assertEqual(await run_alert_rule_evaluation(), 1)
            self.assertEqual(await run_alert_rule_evaluation(), 0)
            self.assertEqual((await self.save("p1", [], 2)).status_code, 200)
            self.assertEqual(await run_alert_rule_evaluation(), 0)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 1)
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)

    async def test_evaluation_waits_for_assignment_commit_then_uses_the_new_selection(self):
        from workflows.activities import run_alert_rule_evaluation
        await self.seed_rule(severity="critical")
        fixed_now = datetime(2026, 10, 7, 13, 0, tzinfo=timezone.utc)
        with patch("workflows.activities.async_session", new=self.sessions), \
             patch("workflows.activities.publish_presence_update", new=AsyncMock()), \
             patch("workflows.activities.datetime", wraps=datetime) as clock:
            clock.now.return_value = fixed_now
            async with self.sessions() as db:
                await replace_alert_rule_assignment(db, "p1", [], "assignment-admin", 0)
                worker = asyncio.create_task(run_alert_rule_evaluation())
                try:
                    with self.assertRaises(asyncio.TimeoutError):
                        await asyncio.wait_for(asyncio.shield(worker), timeout=0.1)
                    await db.commit()
                    self.assertEqual(await asyncio.wait_for(worker, timeout=5), 0)
                finally:
                    if not worker.done():
                        worker.cancel()
                        await asyncio.gather(worker, return_exceptions=True)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Alert)), 0)
            self.assertIsNone(await db.get(CriticalEntryRestriction, "p1"))


if __name__ == "__main__":
    unittest.main()
