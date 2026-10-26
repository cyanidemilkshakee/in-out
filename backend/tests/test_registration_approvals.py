"""Registration and approval transaction boundaries without external services."""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from models import Subject, AccessPermission, PermissionRequestModel, Checkpoint, TerminalCheckpointAssignment
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
    db.scalar = AsyncMock(return_value=TerminalCheckpointAssignment(terminal_identity="browser:operator", checkpoint_id="cp-main"))
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

    def visitor(self):
        return SubjectCreate(barcode="guest-1", kind="visitor", data={
            "name": "Guest", "host": "Host employee", "hours": 3, "purpose": "Project meeting",
            "status": "active", "inside": True, "allowedZones": ["All Zones"], "id": "spoofed",
            "checkpointId": "cp-main",
        })

    async def test_visitor_registration_commits_identity_permission_and_request_together(self):
        db = session()
        db.execute.return_value = scalar_result(Checkpoint(id="cp-main", data={"name": "Main Entrance", "zone": "public"}))
        added, events = [], []
        db.add.side_effect = added.append

        async def commit():
            self.assertEqual(len(added), 3)
            self.assertEqual({type(row) for row in added}, {Subject, AccessPermission, PermissionRequestModel})
            events.append("commit")

        async def refresh(_):
            events.append("refresh")

        async def enqueue(db_arg, result):
            self.assertIs(db_arg, db)
            self.assertEqual(events, [])
            events.append("enqueue")
            request = next(row for row in added if isinstance(row, PermissionRequestModel))
            self.assertEqual(result["request"], request.data)
            self.assertEqual(set(result), {"request", "person"})

        db.commit.side_effect = commit
        db.refresh.side_effect = refresh
        temporal = Mock(start_workflow=AsyncMock())
        with patch("routers.registry.enqueue_decision", new=AsyncMock(side_effect=enqueue)), \
             patch("routers.registry.enqueue_workflow_start", new=AsyncMock()) as start, \
             patch("routers.registry.get_temporal_client", new=AsyncMock(return_value=temporal)):
            result = await create_subject(self.visitor(), db, {"sub": "operator", "realm_access": {"roles": ["operator"]}})

        subject = next(row for row in added if isinstance(row, Subject))
        permission = next(row for row in added if isinstance(row, AccessPermission))
        request = next(row for row in added if isinstance(row, PermissionRequestModel))
        self.assertEqual(result.id, subject.id)
        self.assertNotEqual(result.id, "spoofed")
        self.assertEqual(subject.person.data["status"], "pending_approval")
        self.assertFalse(subject.person.data["inside"])
        self.assertEqual(subject.person.data["allowedZones"], [])
        self.assertEqual(permission.subject_id, subject.id)
        self.assertEqual(permission.data["state"], "pending_approval")
        self.assertEqual(request.subject_id, subject.id)
        self.assertEqual(request.data["requestedZones"], ["public", "secure"])
        self.assertEqual(request.data["validTo"], subject.person.data["validTo"])
        db.commit.assert_awaited_once()
        db.rollback.assert_not_awaited()
        start.assert_awaited_once_with(db, request.id, visitor=True)
        temporal.start_workflow.assert_not_awaited()
        self.assertEqual(events, ["enqueue", "commit", "refresh"])

    async def test_duplicate_barcode_rolls_back_registration_without_publication(self):
        db = session()
        db.execute.return_value = scalar_result(Checkpoint(id="cp-main", data={"zone": "public"}))
        db.commit.side_effect = IntegrityError("INSERT subjects", {}, ValueError("duplicate barcode"))
        with patch("routers.registry.enqueue_decision", new=AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await create_subject(self.visitor(), db, {"sub": "operator"})
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(db.add.call_count, 3)
        db.commit.assert_awaited_once()
        db.rollback.assert_awaited_once()
        db.refresh.assert_not_awaited()
