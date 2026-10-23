"""Exercise visitor registration and asset custody with real session behavior."""
import unittest
from unittest.mock import AsyncMock, patch

import test_database as fixture
from auth import verify_admin_or_operator_request
from models import AccessPermission, PermissionRequestModel, Subject
from sqlalchemy import select
from sqlalchemy.orm import selectinload


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class RegistryCreationWorkflowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown

    async def test_operator_registers_pending_visitor_and_approval_together(self):
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {
            "sub": "operator", "realm_access": {"roles": ["operator"]},
        }
        with patch("routers.registry.publish_decision", new=AsyncMock()), \
             patch("routers.registry.get_temporal_client", new=AsyncMock(side_effect=RuntimeError("offline"))):
            response = await self.client.post("/v1/registry/subjects", json={
                "kind": "visitor", "barcode": "registration-guest", "data": {
                    "name": "Guest", "host": "Alice", "hours": 2, "checkpointId": "cp-main",
                },
            })
        self.assertEqual(response.status_code, 201, response.text)
        data = response.json()
        self.assertEqual(data["data"]["status"], "pending_approval")
        self.assertFalse(data["data"]["inside"])
        self.assertEqual(data["request"]["status"], "pending")
        self.assertEqual(data["request"]["requestedZones"], ["public"])
        async with self.sessions() as db:
            subject = await db.get(Subject, data["id"])
            permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id))
            request = await db.get(PermissionRequestModel, data["request"]["id"])
            self.assertEqual(permission.data["state"], "pending_approval")
            self.assertEqual(request.subject_id, subject.id)

    async def test_created_hardware_uses_registered_owner_as_initial_custodian(self):
        self.app.dependency_overrides[verify_admin_or_operator_request] = lambda: {
            "sub": "admin", "realm_access": {"roles": ["admin"]},
        }
        with patch("routers.registry.publish_data_changed", new=AsyncMock()):
            response = await self.client.post("/v1/registry/subjects", json={
                "kind": "hardware", "barcode": "registration-laptop", "data": {
                    "name": "Laptop", "ownerId": "p1", "owner": "Forged name", "category": "Laptop",
                    "assignedEmployeeId": "someone-else", "allowedZone": "public", "status": "active",
                },
            })
        self.assertEqual(response.status_code, 201, response.text)
        async with self.sessions() as db:
            subject = await db.scalar(select(Subject).options(selectinload(Subject.hardware))
                .where(Subject.id == response.json()["id"]))
            self.assertEqual(subject.hardware.data["assignedEmployeeId"], "p1")
            self.assertEqual(subject.hardware.data["assignedEmployeeName"], "Alice")
            self.assertEqual(subject.hardware.data["owner"], "Alice")
