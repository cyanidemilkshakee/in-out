"""Review/reset contracts, real PostgreSQL ledgers, and routed admin actions."""
import asyncio
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pydantic import ValidationError
from fastapi import HTTPException
from sqlalchemy import select, func, delete

import test_database as database_fixture
from auth import verify_admin_request, verify_terminal_access_request
from models import (Alert, AlertRule, AlertReview, WarningReset, Subject, Person,
    AuditEvent, CriticalEntryRestriction, PresenceState, Movement)
from alert_reviews import AlertReviewInput, WarningResetInput, review_alert, reset_subject_warnings
from critical_entry_restrictions import activate_critical_entry_restrictions


class AlertReviewValidationTests(unittest.TestCase):
    def test_final_decisions_are_strict_and_excuse_requires_trimmed_reason(self):
        self.assertEqual(AlertReviewInput(decision="confirmed").reason, None)
        self.assertEqual(AlertReviewInput(decision="excused", reason=" Operator mistake ").reason, "Operator mistake")
        for body in ({}, {"decision": True}, {"decision": "accepted"}, {"decision": "excused"},
                     {"decision": "excused", "reason": " "}, {"decision": "confirmed", "reason": False},
                     {"decision": "confirmed", "reason": "x" * 1001},
                     {"decision": "confirmed", "count": 2}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                AlertReviewInput.model_validate(body)

    def test_reset_requires_a_nonblank_reason_and_rejects_coercion(self):
        self.assertEqual(WarningResetInput(reason=" Verified ").reason, "Verified")
        for body in ({}, {"reason": " "}, {"reason": None}, {"reason": False}, {"reason": 12},
                     {"reason": "x" * 1001}, {"reason": "Checked", "liftRestriction": False}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                WarningResetInput.model_validate(body)


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Set TEST_DATABASE_URL for isolated PostgreSQL integration tests")
class AlertReviewDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = database_fixture.DatabaseTests.asyncSetUp
    asyncTearDown = database_fixture.DatabaseTests.asyncTearDown

    def authorize(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "review-admin"}
        self.app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}

    async def create_alert(self, *, subject_id="p1", barcode=None, severity="medium", **extra):
        alert_id = "AL-" + uuid.uuid4().hex
        now = datetime.now(timezone.utc)
        data = {"id": alert_id, "title": "No break recorded", "reason": "Full workday without a break",
            "severity": severity, "status": "open", "createdAt": now.isoformat(), **extra}
        if subject_id is not None:
            data["subjectId"] = subject_id
        if barcode is not None:
            data["barcode"] = barcode
        async with self.sessions() as db:
            alert = Alert(id=alert_id, created_at=now, data=data)
            db.add(alert)
            await activate_critical_entry_restrictions(db, [alert])
            await db.commit()
        return alert_id

    async def review(self, alert_id, decision="confirmed", reason=None):
        body = {"decision": decision}
        if reason is not None:
            body["reason"] = reason
        with patch("routers.alerts.publish_data_changed", new=AsyncMock()):
            return await self.client.post(f"/v1/alerts/{alert_id}/review", json=body)

    async def reset(self, subject_id="p1", reason="Warnings checked and entry may resume"):
        with patch("routers.alerts.publish_data_changed", new=AsyncMock()):
            return await self.client.post(f"/v1/alert-warnings/{subject_id}/reset", json={"reason": reason})

    async def audit_count(self):
        async with self.sessions() as db:
            return await db.scalar(select(func.count()).select_from(AuditEvent))

    async def test_review_and_reset_require_admin_and_strict_http_payloads(self):
        alert_id = await self.create_alert()
        review_url = f"/v1/alerts/{alert_id}/review"
        reset_url = "/v1/alert-warnings/p1/reset"
        for url, body in ((review_url, {"decision": "confirmed"}), (reset_url, {"reason": "Checked"})):
            self.assertEqual((await self.client.post(url, json=body)).status_code, 401)
            with patch("auth.verify_authenticated_request", new=AsyncMock(return_value={
                    "sub": "operator", "realm_access": {"roles": ["operator"]}})):
                self.assertEqual((await self.client.post(url, json=body)).status_code, 403)
        self.authorize()
        for body in ({"decision": True}, {"decision": "excused", "reason": " "},
                     {"decision": "confirmed", "reason": 4}, {"decision": "confirmed", "extra": True}):
            self.assertEqual((await self.client.post(review_url, json=body)).status_code, 422)
        for body in ({"reason": " "}, {"reason": False}, {"reason": "Checked", "count": 0}):
            self.assertEqual((await self.client.post(reset_url, json=body)).status_code, 422)
        self.assertEqual((await self.review("missing")).status_code, 404)
        self.assertEqual((await self.reset("missing")).status_code, 404)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AlertReview)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(WarningReset)), 0)

    async def test_confirm_is_durable_idempotent_final_and_ack_cannot_hide_warning(self):
        self.authorize()
        alert_id = await self.create_alert(subjectName="Incorrect legacy name")
        first = await self.review(alert_id, reason=" Real event ")
        self.assertEqual(first.status_code, 200, first.text)
        data = first.json()
        self.assertEqual(data["alert"]["status"], "warned")
        self.assertEqual(data["alert"]["review"]["reason"], "Real event")
        self.assertEqual(data["alert"]["subjectName"], "Alice")
        self.assertEqual(data["warning"]["count"], 1)
        retry = await self.review(alert_id, reason="Retry must not rewrite history")
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json()["alert"], data["alert"])
        self.assertNotIn("auditEvent", retry.json())
        self.assertEqual(await self.audit_count(), 1)
        self.assertEqual((await self.review(alert_id, "excused", "Changed mind")).status_code, 409)
        self.assertEqual((await self.client.patch(f"/v1/alerts/{alert_id}",
            json={"status": "acknowledged"})).status_code, 409)
        active = (await self.client.get("/v1/alerts", params={"status": "active"})).json()
        self.assertEqual([item["id"] for item in active["items"]], [alert_id])
        self.assertEqual(next(item for item in active["warnings"] if item["subjectId"] == "h1")["count"], 0)

    async def test_excuse_is_final_preserves_critical_hold_and_does_not_count(self):
        self.authorize()
        alert_id = await self.create_alert(severity="critical")
        result = await self.review(alert_id, "excused", " Entry was recorded on paper ")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["alert"]["status"], "resolved")
        self.assertEqual(result.json()["warning"]["count"], 0)
        self.assertTrue(result.json()["alert"]["entryRestriction"]["active"])
        retry = await self.review(alert_id, "excused", "Different retry reason")
        self.assertEqual(retry.json()["alert"]["review"], result.json()["alert"]["review"])
        self.assertEqual(await self.audit_count(), 2)  # Activation and one review.
        self.assertEqual((await self.review(alert_id)).status_code, 409)
        active = (await self.client.get("/v1/alerts", params={"status": "active"})).json()
        self.assertEqual(active["items"], [])
        self.assertTrue(next(row for row in active["warnings"] if row["subjectId"] == "p1")["entryRestriction"]["active"])

    async def test_binding_uses_registered_identity_or_unique_barcode_never_name(self):
        self.authorize()
        for fields in ({"subject_id": None, "subjectName": "Alice"},
                       {"subject_id": "missing", "barcode": "p1"}, {"subject_id": " ", "barcode": "p1"}):
            alert_id = await self.create_alert(**fields)
            self.assertEqual((await self.review(alert_id)).status_code, 422)
            excuse = await self.review(alert_id, "excused", "Cannot bind to a registered subject")
            self.assertEqual(excuse.status_code, 200, excuse.text)
            self.assertNotIn("subjectId", excuse.json()["alert"])
        alert_id = await self.create_alert(subject_id=None, barcode=" P1 ")
        result = await self.review(alert_id)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["alert"]["subjectId"], "p1")
        self.assertEqual(result.json()["warning"]["count"], 1)
        async with self.sessions() as db:
            self.assertEqual((await db.get(AlertReview, alert_id)).subject_id, "p1")
            self.assertEqual((await db.get(Alert, alert_id)).data["subjectId"], "p1")

    async def test_reset_clears_count_lifts_current_hold_preserves_history_and_is_idempotent(self):
        self.authorize()
        first_id = await self.create_alert()
        critical_id = await self.create_alert(severity="critical")
        for alert_id in (first_id, critical_id):
            self.assertEqual((await self.review(alert_id)).status_code, 200)
        before = await self.audit_count()
        reset = await self.reset(reason=" Checked records; reset and allow entry ")
        self.assertEqual(reset.status_code, 200, reset.text)
        data = reset.json()
        self.assertEqual(data["warning"]["count"], 0)
        self.assertEqual(data["warning"]["resetBy"], "review-admin")
        self.assertFalse(data["entryRestriction"]["active"])
        self.assertEqual(data["entryRestriction"]["releaseReason"], "Checked records; reset and allow entry")
        self.assertEqual(await self.audit_count(), before + 2)
        history = (await self.client.get("/v1/alerts")).json()["items"]
        for item in history:
            self.assertEqual(item["status"], "acknowledged")
            self.assertEqual(item["review"]["decision"], "confirmed")
            self.assertEqual(item["warningResetAt"], data["warning"]["resetAt"])
            self.assertEqual(item["warningResetReason"], "Checked records; reset and allow entry")
        self.assertEqual((await self.client.get("/v1/alerts", params={"status": "active"})).json()["items"], [])
        again = await self.reset(reason="Repeat must not change the epoch")
        self.assertEqual(again.json()["warning"], data["warning"])
        self.assertNotIn("auditEvent", again.json())
        self.assertEqual(await self.audit_count(), before + 2)
        retry = await self.review(first_id)
        self.assertEqual(retry.json()["alert"]["status"], "acknowledged")
        self.assertEqual(retry.json()["warning"]["count"], 0)
        new_id = await self.create_alert()
        self.assertNotIn("warningResetAt", (await self.client.get("/v1/alerts",
            params={"status": "open"})).json()["items"][0])
        self.assertEqual((await self.review(new_id)).json()["warning"]["count"], 1)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(AlertReview)), 3)
            self.assertEqual((await db.get(CriticalEntryRestriction, "p1")).released_by, "review-admin")
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), 0)
            self.assertIsNone(await db.get(PresenceState, "p1"))

    async def test_zero_count_reset_still_lifts_new_hold_without_excusing_pending_alert(self):
        self.authorize()
        first = await self.reset()
        self.assertEqual(first.json()["warning"]["count"], 0)
        critical_id = await self.create_alert(severity="critical")
        reset = await self.reset(reason="Release newly raised hold")
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertFalse(reset.json()["entryRestriction"]["active"])
        self.assertNotEqual(first.json()["warning"]["resetAt"], reset.json()["warning"]["resetAt"])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Alert, critical_id)).data["status"], "open")
            self.assertIsNone(await db.get(AlertReview, critical_id))
        # A later, distinct critical alert can restrict entry again.
        await self.create_alert(severity="critical")
        history = (await self.client.get("/v1/alerts")).json()
        self.assertTrue(next(row for row in history["warnings"] if row["subjectId"] == "p1")["entryRestriction"]["active"])

    async def test_reset_lifts_scan_entry_hold_without_changing_presence_or_normal_access(self):
        self.authorize()
        await self.create_alert(severity="critical")
        async def scan():
            with patch("routers.terminal.publish_presence_update", new=AsyncMock()):
                return await self.client.post("/v1/terminal/scans",
                    json={"barcode": "p1", "checkpointId": "cp-main", "direction": "entry"},
                    headers={"Idempotency-Key": str(uuid.uuid4())})
        blocked = await scan()
        self.assertFalse(blocked.json()["allowed"], blocked.text)
        async with self.sessions() as db:
            state = await db.get(PresenceState, "p1")
            before = (state.state, state.last_scan_timestamp, state.entry_override)
            movement_count = await db.scalar(select(func.count()).select_from(Movement))
            person_data = (await db.get(Person, "p1")).data
        reset = await self.reset()
        self.assertEqual(reset.status_code, 200, reset.text)
        async with self.sessions() as db:
            state = await db.get(PresenceState, "p1")
            self.assertEqual((state.state, state.last_scan_timestamp, state.entry_override), before)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Movement)), movement_count)
            self.assertEqual((await db.get(Person, "p1")).data, person_data)
        entered = await scan()
        self.assertTrue(entered.json()["allowed"], entered.text)
        self.assertEqual(entered.json()["decision"]["event"]["direction"], "entry")

    async def test_retention_keeps_confirmed_count_identity_and_reset_history(self):
        self.authorize()
        alert_id = await self.create_alert()
        self.assertEqual((await self.review(alert_id)).status_code, 200)
        async with self.sessions() as db:
            await db.execute(delete(Alert).where(Alert.id == alert_id))
            await db.commit()
        result = (await self.client.get("/v1/alerts")).json()
        self.assertEqual([item["id"] for item in result["items"]], [alert_id])
        self.assertEqual(result["items"][0]["status"], "warned")
        self.assertEqual(next(row for row in result["warnings"] if row["subjectId"] == "p1")["count"], 1)
        self.assertEqual((await self.review(alert_id)).json()["warning"]["count"], 1)
        self.assertEqual((await self.reset()).json()["warning"]["count"], 0)
        retry = await self.review(alert_id)
        self.assertEqual(retry.json()["alert"]["status"], "acknowledged")
        self.assertIn("warningResetAt", retry.json()["alert"])
        deleted = await self.client.delete("/v1/registry/subjects/p1")
        self.assertEqual(deleted.status_code, 409, deleted.text)
        async with self.sessions() as db:
            self.assertIsNotNone(await db.get(Subject, "p1"))
            self.assertIsNotNone(await db.get(AlertReview, alert_id))

    async def test_list_filters_pagination_and_literal_search_include_review_reason(self):
        self.authorize()
        matched = await self.create_alert(title="Badge 100%_\\ checked", subjectName="Alice")
        other = await self.create_alert(subject_id="h1", title="Badge 10000 checked")
        await self.review(matched, "excused", "Paper correction 50%_")
        result = (await self.client.get("/v1/alerts", params={"search": "100%_\\", "limit": 1})).json()
        self.assertEqual((result["total"], result["limit"], result["offset"]), (1, 1, 0))
        self.assertEqual(result["items"][0]["id"], matched)
        result = (await self.client.get("/v1/alerts", params={"search": "CORRECTION 50%_"})).json()
        self.assertEqual([item["id"] for item in result["items"]], [matched])
        result = (await self.client.get("/v1/alerts", params={"subjectId": "h1"})).json()
        self.assertEqual([item["id"] for item in result["items"]], [other])
        self.assertEqual(len(result["warnings"]), 2)
        result = (await self.client.get("/v1/alerts", params={"limit": 1, "offset": 1})).json()
        self.assertEqual((result["total"], len(result["items"])), (2, 1))

    async def test_rule_definitions_are_read_only_without_any_mutation(self):
        self.authorize()
        async with self.sessions() as db:
            before = {row.id: row.data for row in (await db.scalars(select(AlertRule))).all()}
        for body in ({"enabled": False}, {"severity": "critical"},
                     {"scope": "All subjects", "name": "Changed", "description": "Changed"}):
            result = await self.client.patch("/v1/alert-rules/rule-no-break", json=body)
            self.assertEqual(result.status_code, 403, result.text)
            self.assertIn("read-only", result.json()["detail"])
        self.assertEqual((await self.client.patch("/v1/alert-rules/new-rule", json={"enabled": True})).status_code, 403)
        async with self.sessions() as db:
            self.assertEqual({row.id: row.data for row in (await db.scalars(select(AlertRule))).all()}, before)
        self.assertEqual(await self.audit_count(), 0)

    async def test_concurrent_same_review_creates_one_count_and_conflicting_review_is_final(self):
        alert_id = await self.create_alert()
        async def perform(decision, reason=None):
            async with self.sessions() as db:
                try:
                    result = await review_alert(db, alert_id, decision, "parallel-admin", reason)
                    await db.commit()
                    return result
                except HTTPException as error:
                    await db.rollback()
                    return error.status_code
        first, second = await asyncio.gather(perform("confirmed"), perform("confirmed"))
        self.assertEqual(first["warning"]["count"], 1)
        self.assertEqual(second["warning"]["count"], 1)
        self.assertEqual(sum("auditEvent" in result for result in (first, second)), 1)
        self.assertEqual(await perform("excused", "Conflict"), 409)
        self.assertEqual(await self.audit_count(), 1)

    async def test_competing_final_decisions_have_one_winner_and_one_audit(self):
        alert_id = await self.create_alert()
        async def perform(decision):
            async with self.sessions() as db:
                try:
                    result = await review_alert(db, alert_id, decision, "parallel-admin", "Checked event")
                    await db.commit()
                    return 200, result
                except HTTPException as error:
                    await db.rollback()
                    return error.status_code, None
        results = await asyncio.gather(perform("confirmed"), perform("excused"))
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        winner = next(result for status, result in results if status == 200)
        self.assertEqual(winner["warning"]["count"], 1 if winner["alert"]["review"]["decision"] == "confirmed" else 0)
        self.assertEqual(await self.audit_count(), 1)

    async def test_review_waits_for_reset_and_new_warning_is_counted_after_its_epoch(self):
        alert_id = await self.create_alert()
        async with self.sessions() as reset_db:
            await reset_db.execute(select(Subject.id).where(Subject.id == "p1").with_for_update())
            reset = await reset_subject_warnings(reset_db, "p1", "reset-admin", "Before new warning")
            async def perform():
                async with self.sessions() as review_db:
                    result = await review_alert(review_db, alert_id, "confirmed", "review-admin")
                    await review_db.commit()
                    return result
            task = asyncio.create_task(perform())
            try:
                done, _ = await asyncio.wait({task}, timeout=0.1)
                self.assertFalse(done)
                await reset_db.commit()
                result = await asyncio.wait_for(task, timeout=5)
                self.assertEqual(result["warning"]["count"], 1)
                self.assertGreater(result["alert"]["review"]["reviewedAt"], reset["warning"]["resetAt"])
                self.assertNotIn("warningResetAt", result["alert"])
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_reset_waits_for_review_commit_then_clears_that_warning(self):
        alert_id = await self.create_alert()
        async with self.sessions() as review_db:
            review = await review_alert(review_db, alert_id, "confirmed", "review-admin")
            self.assertEqual(review["warning"]["count"], 1)
            async def perform():
                async with self.sessions() as reset_db:
                    result = await reset_subject_warnings(reset_db, "p1", "reset-admin", "After confirmed warning")
                    await reset_db.commit()
                    return result
            task = asyncio.create_task(perform())
            try:
                done, _ = await asyncio.wait({task}, timeout=0.1)
                self.assertFalse(done)
                await review_db.commit()
                result = await asyncio.wait_for(task, timeout=5)
                self.assertEqual(result["warning"]["count"], 0)
                async with self.sessions() as db:
                    self.assertEqual((await db.get(Alert, alert_id)).data["status"], "acknowledged")
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_reset_rollback_restores_count_hold_alert_status_and_all_audits(self):
        self.authorize()
        alert_id = await self.create_alert(severity="critical")
        await self.review(alert_id)
        before = await self.audit_count()
        async with self.sessions() as db:
            reset = await reset_subject_warnings(db, "p1", "reset-admin", "Rollback exercise")
            self.assertEqual(reset["warning"]["count"], 0)
            self.assertFalse(reset["entryRestriction"]["active"])
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(Alert, alert_id)).data["status"], "warned")
            self.assertIsNone(await db.get(WarningReset, "p1"))
            self.assertTrue((await db.get(CriticalEntryRestriction, "p1")).active)
            self.assertNotIn("warningReset", (await db.get(AlertReview, alert_id)).alert_data)
        self.assertEqual(await self.audit_count(), before)

    async def test_publication_failure_does_not_lose_committed_review_or_reset(self):
        self.authorize()
        alert_id = await self.create_alert()
        with patch("routers.alerts.publish_data_changed", new=AsyncMock(side_effect=RuntimeError("Redis offline"))):
            review = await self.client.post(f"/v1/alerts/{alert_id}/review", json={"decision": "confirmed"})
            reset = await self.client.post("/v1/alert-warnings/p1/reset", json={"reason": "Checked"})
        self.assertEqual(review.status_code, 200, review.text)
        self.assertEqual(reset.status_code, 200, reset.text)
        async with self.sessions() as db:
            self.assertEqual((await db.get(AlertReview, alert_id)).decision, "confirmed")
            self.assertIsNotNone(await db.get(WarningReset, "p1"))
            self.assertEqual((await db.get(Alert, alert_id)).data["status"], "acknowledged")
