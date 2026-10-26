"""Subject documents cannot grow by accumulating individually small patches."""
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select

import test_database as fixture
from auth import verify_admin_or_operator_request, verify_admin_request
from config import Settings, settings
from models import AccessPermission, Person, PermissionRequestModel, Subject, EventOutbox
from routers.registry import create_subject, update_subject
from schemas import SubjectCreate, SubjectUpdate
from subject_metadata import validate_subject_metadata_size

ADMIN = {"sub": "metadata-admin", "realm_access": {"roles": ["admin"]}}
OPERATOR = {"sub": "operator", "realm_access": {"roles": ["operator"]}}


def padded_metadata(size):
    data = {"name": "Alice", "allowedZones": ["public"], "extension": ""}
    overhead = len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode())
    data["extension"] = "x" * (size - overhead)
    return data


def fake_session(subject=None, permission=None):
    result = Mock()
    result.scalar_one_or_none.return_value = subject
    return Mock(execute=AsyncMock(return_value=result), scalar=AsyncMock(return_value=permission),
                get=AsyncMock(return_value=subject),
                add=Mock(), flush=AsyncMock(), commit=AsyncMock(), refresh=AsyncMock(),
                rollback=AsyncMock(), info={})


class MetadataSizeTests(unittest.TestCase):
    def test_exact_utf8_boundary_includes_unicode_keys_values_and_json_structure(self):
        # 12 JSON structural/key bytes plus 253 four-byte Unicode characters.
        document = {"extra": "🙂" * 253}
        original = copy.deepcopy(document)
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", 1024):
            validate_subject_metadata_size(document)
            with self.assertRaises(HTTPException) as caught:
                validate_subject_metadata_size({"extra": document["extra"] + "x"})
            with self.assertRaises(HTTPException):
                validate_subject_metadata_size({"extré": document["extra"]})
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(document, original)

    def test_nested_unknown_keys_and_escaped_text_are_preserved_within_limit(self):
        document = {"unknown": {"values": [None, 1, False, "\n\"\\", "é"]}}
        original = copy.deepcopy(document)
        encoded_size = len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode())
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", encoded_size):
            validate_subject_metadata_size(document)
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", encoded_size - 1):
            with self.assertRaises(HTTPException):
                validate_subject_metadata_size(document)
        self.assertEqual(document, original)

    def test_invalid_json_numbers_and_unicode_fail_before_database_serialization(self):
        for document in ({"extra": float("nan")}, {"extra": "\ud800"}):
            with self.subTest(document_type=type(document["extra"]).__name__):
                with self.assertRaises(HTTPException) as caught:
                    validate_subject_metadata_size(document)
                self.assertEqual(caught.exception.status_code, 422)

    def test_excessive_nesting_returns_validation_error_instead_of_recursion_failure(self):
        document = {"leaf": "ok"}
        for _ in range(1050):
            document = {"nest": document}
        with self.assertRaises(HTTPException) as caught:
            validate_subject_metadata_size(document)
        self.assertEqual(caught.exception.status_code, 422)

    def test_config_has_safe_default_and_rejects_unbounded_values(self):
        self.assertEqual(Settings(_env_file=None).MAX_SUBJECT_METADATA_BYTES, 16384)
        for value in (1023, 262145):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None, MAX_SUBJECT_METADATA_BYTES=value)


class MetadataWriteUnitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        item = patch("routers.registry.enqueue_changed", new=AsyncMock(return_value=1))
        item.start()
        self.addCleanup(item.stop)

    async def test_operator_oversize_visitor_stops_before_identity_and_approval_mutations(self):
        db = fake_session()
        payload = SubjectCreate(kind="visitor", barcode="guest-large", data={
            "name": "Guest", "host": "Alice", "hours": 1,
            "extension": "x" * settings.MAX_SUBJECT_METADATA_BYTES,
        })
        with self.assertRaises(HTTPException) as caught:
            await create_subject(payload, db, OPERATOR)
        self.assertEqual(caught.exception.status_code, 422)
        db.execute.assert_not_awaited()
        db.add.assert_not_called()
        db.flush.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_creation_counts_complete_server_metadata_before_adding_rows(self):
        db = fake_session()
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", 1024):
            payload = SubjectCreate(kind="employee", barcode="employee-large", data=padded_metadata(1024))
            with self.assertRaises(HTTPException) as caught:
                await create_subject(payload, db, ADMIN)
        self.assertEqual(caught.exception.status_code, 422)
        db.add.assert_not_called()
        db.flush.assert_not_awaited()
        db.commit.assert_not_awaited()

    async def test_cumulative_patch_does_not_change_barcode_metadata_or_permission(self):
        subject = Subject(id="employee", kind="employee", barcode="OLD", person=Person(data={
            "name": "Alice", "status": "active", "allowedZones": ["public"], "extraA": "a" * 700,
            "validFrom": "2026-01-01T00:00:00Z", "validTo": "",
        }))
        permission = AccessPermission(id="permission", subject_id=subject.id,
            data={"state": "active", "zones": ["public"]})
        original, original_permission = copy.deepcopy(subject.person.data), copy.deepcopy(permission.data)
        db = fake_session(subject, permission)
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", 1024):
            with self.assertRaises(HTTPException) as caught:
                await update_subject(subject.id, SubjectUpdate(barcode="NEW", data={
                    "extraB": "b" * 400, "allowedZones": ["secure"], "status": "restricted"}), db, ADMIN)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(subject.barcode, "OLD")
        self.assertEqual(subject.person.data, original)
        self.assertEqual(permission.data, original_permission)
        db.scalar.assert_not_awaited()
        db.add.assert_not_called()
        db.commit.assert_not_awaited()

    async def test_normal_unknown_metadata_remains_supported(self):
        db = fake_session()
        payload = SubjectCreate(kind="employee", barcode="NORMAL", data={
            "name": "Alice", "allowedZones": ["public"], "extension": {"notes": ["é", "ok"]},
        })
        with patch("routers.registry.enqueue_changed", new=AsyncMock()):
            result = await create_subject(payload, db, ADMIN)
        self.assertEqual(result.data["extension"], {"notes": ["é", "ok"]})
        db.commit.assert_awaited_once()


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class MetadataWriteDatabaseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def counts(self):
        async with self.sessions() as db:
            return tuple([await db.scalar(select(func.count()).select_from(model))
                          for model in (Subject, Person, AccessPermission, PermissionRequestModel)])

    async def test_operator_oversize_create_has_no_subject_permission_or_approval(self):
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: OPERATOR
        before = await self.counts()
        response = await self.client.post("/v1/registry/subjects", json={
            "kind": "visitor", "barcode": "oversize-visitor", "data": {
                "name": "Guest", "host": "Alice", "hours": 1,
                "extension": "x" * settings.MAX_SUBJECT_METADATA_BYTES,
            }})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(await self.counts(), before)

    async def test_final_create_overhead_is_rejected_before_any_registry_rows(self):
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: ADMIN
        before = await self.counts()
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", 1024):
            response = await self.client.post("/v1/registry/subjects", json={
                "kind": "employee", "barcode": "server-overhead", "data": padded_metadata(1024)})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(await self.counts(), before)

    async def test_cumulative_merge_rejection_preserves_access_and_small_update_works(self):
        self.app.dependency_overrides[verify_admin_request] = lambda: ADMIN
        async with self.sessions() as db:
            person = await db.get(Person, "p1")
            original = {**person.data, "extraA": "a" * 1400}
            person.data = original
            original_permission = {"state": "active", "zones": ["public"], "subjectName": "Alice"}
            db.add(AccessPermission(id="metadata-permission", subject_id="p1", data=original_permission))
            await db.commit()
        with patch.object(settings, "MAX_SUBJECT_METADATA_BYTES", 2048):
            denied = await self.client.put("/v1/registry/subjects/p1", json={"barcode": "changed-barcode",
                "data": {"extraB": "b" * 700, "allowedZones": ["secure"], "status": "restricted"}})
            self.assertEqual(denied.status_code, 422, denied.text)
            async with self.sessions() as db:
                self.assertEqual((await db.get(Subject, "p1")).barcode, "p1")
                self.assertEqual((await db.get(Person, "p1")).data, original)
                self.assertEqual((await db.get(AccessPermission, "metadata-permission")).data, original_permission)
            accepted = await self.client.put("/v1/registry/subjects/p1", json={
                "data": {"extraB": "small", "allowedZones": ["secure"]}})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual(accepted.json()["data"]["extraA"], original["extraA"])
            self.assertEqual(accepted.json()["data"]["extraB"], "small")
            async with self.sessions() as db:
                self.assertEqual(await db.scalar(select(func.count()).select_from(EventOutbox)), 1)
        async with self.sessions() as db:
            permission = await db.get(AccessPermission, "metadata-permission")
            self.assertEqual(permission.data["zones"], ["secure"])
            self.assertEqual(permission.data["state"], "active")


if __name__ == "__main__":
    unittest.main()
