"""Registration and approval transaction boundaries without external services."""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from models import Subject, AccessPermission, AuditEvent, PermissionRequestModel, Checkpoint, OrganizationZone, TerminalCheckpointAssignment
from schemas import SubjectCreate
from routers.registry import create_subject


def scalar_result(value):
    result = Mock()
    result.scalar_one_or_none.return_value = value
    return result


@contextmanager
def no_autoflush():
    """Match SQLAlchemy's synchronous context manager, not an async mock."""
    yield


def session():
    db = Mock()
    db.no_autoflush = no_autoflush()
    db.execute = AsyncMock()
    async def scalar(query, *args, **kwargs):
        if "organization_zones" in str(query):
            return OrganizationZone(id="a", name="A", active=True)
        return TerminalCheckpointAssignment(terminal_identity="browser:operator", checkpoint_id="cp-main")
    db.scalar = AsyncMock(side_effect=scalar)
    db.get = AsyncMock(side_effect=lambda model, identity, **kwargs:
        Checkpoint(id=identity, zone_id="a", active=True,
            data={"name": "Main Entrance", "zone": "a"}) if model is Checkpoint else None)
    rows = Mock()
    rows.all.return_value = []
    db.scalars = AsyncMock(return_value=rows)
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.rollback = AsyncMock()
    return db


class RegistrationApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for target in ("routers.registry.enqueue_workflow_start", "routers.registry.enqueue_decision", "routers.registry.enqueue_changed"):
            item = patch(target, new=AsyncMock(return_value=1))
            item.start()
            self.addCleanup(item.stop)
        for target, attribute in (("temporal_worker.get_temporal_client", "temporal"),
                                  ("redis_client.publish_presence_update", "publish")):
            item = patch(target, new=AsyncMock())
            setattr(self, attribute, item.start())
            self.addCleanup(item.stop)

    def visitor(self):
        return SubjectCreate(barcode="guest-1", kind="visitor", data={
            "name": "Guest", "host": "Host employee", "hours": 3, "purpose": "Project meeting",
            "status": "active", "inside": True, "allowedZones": ["All Zones"], "id": "spoofed",
            "checkpointId": "cp-main",
        })

    async def test_visitor_registration_commits_identity_permission_and_request_together(self):
        db = session()
        db.execute.side_effect = [
            scalar_result("cp-main"),
            scalar_result(Checkpoint(id="cp-main", zone_id="a",
                data={"name": "Main Entrance", "zone": "a"})),
        ]
        added, events = [], []
        db.add.side_effect = added.append

        async def commit():
            self.assertEqual(len(added), 4)
            self.assertEqual({type(row) for row in added}, {Subject, AccessPermission, PermissionRequestModel, AuditEvent})
            events.append("commit")

        async def enqueue(db_arg, result):
            self.assertIs(db_arg, db)
            self.assertEqual(events, [])
            events.append("enqueue")
            request = next(row for row in added if isinstance(row, PermissionRequestModel))
            self.assertEqual(result["request"], request.data)
            self.assertEqual(set(result), {"request", "person"})

        db.commit.side_effect = commit
        db.refresh.side_effect = AssertionError("A committed registration already has its complete response")
        with patch("routers.registry.enqueue_decision", new=AsyncMock(side_effect=enqueue)), \
             patch("routers.registry.enqueue_workflow_start", new=AsyncMock()) as start:
            result = await create_subject(self.visitor(), db, {"sub": "operator", "realm_access": {"roles": ["operator"]}})

        subject = next(row for row in added if isinstance(row, Subject))
        permission = next(row for row in added if isinstance(row, AccessPermission))
        request = next(row for row in added if isinstance(row, PermissionRequestModel))
        audit = next(row for row in added if isinstance(row, AuditEvent))
        self.assertEqual(result.id, subject.id)
        self.assertNotEqual(result.id, "spoofed")
        self.assertEqual(subject.person.data["status"], "pending_approval")
        self.assertFalse(subject.person.data["inside"])
        self.assertEqual(subject.person.data["allowedZones"], [])
        self.assertEqual(permission.subject_id, subject.id)
        self.assertEqual(permission.data["state"], "pending_approval")
        self.assertEqual(request.subject_id, subject.id)
        self.assertEqual(request.data["requestedZones"], ["a"])
        self.assertEqual(request.data["validTo"], subject.person.data["validTo"])
        self.assertEqual(audit.data["subjectId"], subject.id)
        self.assertEqual(audit.data["actor"], "operator")
        self.assertEqual(audit.data["zoneId"], "a")
        self.assertEqual(audit.data["after"]["status"], "pending_approval")
        db.commit.assert_awaited_once()
        db.rollback.assert_not_awaited()
        start.assert_awaited_once_with(db, request.id, visitor=True)
        self.temporal.assert_not_awaited()
        self.publish.assert_not_awaited()
        self.assertEqual(events, ["enqueue", "commit"])
        db.refresh.assert_not_awaited()

    async def test_duplicate_barcode_rolls_back_registration_without_publication(self):
        db = session()
        db.execute.side_effect = [
            scalar_result("cp-main"),
            scalar_result(Checkpoint(id="cp-main", zone_id="a", data={"zone": "a"})),
        ]
        db.commit.side_effect = IntegrityError("INSERT subjects", {}, ValueError("duplicate barcode"))
        with patch("routers.registry.enqueue_decision", new=AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await create_subject(self.visitor(), db, {"sub": "operator"})
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(db.add.call_count, 4)
        self.assertEqual({type(call.args[0]) for call in db.add.call_args_list},
                         {Subject, AccessPermission, PermissionRequestModel, AuditEvent})
        db.commit.assert_awaited_once()
        db.rollback.assert_awaited_once()
        db.refresh.assert_not_awaited()
        self.temporal.assert_not_awaited()
        self.publish.assert_not_awaited()
