"""Zone retirement must not strand people who are still inside the branch."""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException

from models import OrganizationZone
from routers import zones


class ZoneRetirementTests(unittest.IsolatedAsyncioTestCase):
    async def test_zone_with_an_active_visit_cannot_be_retired(self):
        zone = OrganizationZone(id="b", name="B", active=True)
        db = Mock(
            scalar=AsyncMock(side_effect=[zone, None, "visitor-1"]),
            commit=AsyncMock(),
        )
        actor = {"sub": "master", "realm_access": {"roles": ["master-admin", "admin"]}}

        with patch("routers.zones.enqueue_changed", new=AsyncMock()) as enqueue:
            with self.assertRaises(HTTPException) as error:
                await zones.delete_zone("b", db, actor)

        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("active visits", error.exception.detail)
        db.commit.assert_not_awaited()
        enqueue.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
