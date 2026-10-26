"""A pending visitor remains HTTP-approvable during a workflow outage."""
import unittest
from datetime import datetime, timedelta, timezone

import test_database as fixture
from auth import verify_admin_request
from models import AccessPermission, PermissionRequestModel, Person
from permission_decisions import apply_permission_decision
import test_workflow_edges as edges


@unittest.skipUnless(fixture.TEST_URL, "Set TEST_DATABASE_URL for isolated PostgreSQL tests")
class LateVisitorApprovalTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.DatabaseTests.asyncSetUp
    asyncTearDown = fixture.DatabaseTests.asyncTearDown
    authorize = edges.WorkflowEdgeTests.authorize
    add_visitor = edges.WorkflowEdgeTests.add_visitor
    request = edges.WorkflowEdgeTests.request

    async def test_http_approval_after_thirty_minutes_is_preserved_when_timeout_delivery_recovers(self):
        await self.add_visitor()
        created = await self.request()
        self.assertEqual(created.status_code, 200, created.text)
        request_id = created.json()["id"]
        async with self.sessions() as db:
            request = await db.get(PermissionRequestModel, request_id)
            request.created_at = datetime.now(timezone.utc) - timedelta(minutes=45)
            await db.commit()

        self.app.dependency_overrides[verify_admin_request] = lambda: {"sub": "late-admin", "realm_access": {"roles": ["admin"]}}
        approved = await self.client.post(f"/v1/permission-requests/{request_id}/decide", json={
            "decision": "approved", "reason": "Verified while the workflow worker was unavailable",
        })
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["request"]["status"], "approved")
        async with self.sessions() as db:
            permission_before = dict((await db.get(AccessPermission, "visitor-permission")).data)
            person_before = dict((await db.get(Person, "v1")).data)
            recovered = await apply_permission_decision(db, request_id, "denied", "system", "Recovered timeout",
                from_activity=True, expire_only=True)
            await db.commit()
            self.assertEqual(recovered["request"]["status"], "approved")
            self.assertEqual((await db.get(AccessPermission, "visitor-permission")).data, permission_before)
            self.assertEqual((await db.get(Person, "v1")).data, person_before)


if __name__ == "__main__":
    unittest.main()
