"""Provider paging must remain correct after application zone filtering."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from routers import keycloak_admin


def rows(values):
    result = MagicMock()
    result.all.return_value = values
    result.__iter__.return_value = iter(values)
    result.scalars.return_value = result
    return result


class KeycloakAdminPagingTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_hidden_provider_page_can_advance_without_fetching_hidden_roles(self):
        users = [{"id": "outside-1"}, {"id": "outside-2"}]
        assignments = [SimpleNamespace(terminal_identity="browser:" + user["id"], checkpoint_id="outside") for user in users]
        db = SimpleNamespace(execute=AsyncMock(return_value=rows(assignments)), scalars=AsyncMock(side_effect=[
            rows([SimpleNamespace(id="outside", zone_id="b")]), rows([])]))
        with patch("routers.keycloak_admin._request", new=AsyncMock(return_value=httpx.Response(200, json=users))), \
             patch("routers.keycloak_admin.admin_zone_ids", new=AsyncMock(return_value=["a"])), \
             patch("routers.keycloak_admin._user_roles", new=AsyncMock()) as roles:
            result = await keycloak_admin.list_users(search="", first=10, max_results=2, token="test-only", db=db,
                actor={"realm_access": {"roles": ["zone-admin"]}})
        self.assertEqual((result["items"], result["hasMore"], result["nextFirst"]), ([], True, 12))
        roles.assert_not_awaited()

    async def test_partial_provider_page_is_final_and_visible_roles_are_still_verified(self):
        user = {"id": "inside", "username": "operator"}
        db = SimpleNamespace(execute=AsyncMock(return_value=rows([
            SimpleNamespace(terminal_identity="browser:inside", checkpoint_id="inside")])),
            scalars=AsyncMock(side_effect=[rows([SimpleNamespace(id="inside", zone_id="a")]), rows([])]))
        with patch("routers.keycloak_admin._request", new=AsyncMock(return_value=httpx.Response(200, json=[user]))), \
             patch("routers.keycloak_admin.admin_zone_ids", new=AsyncMock(return_value=["a"])), \
             patch("routers.keycloak_admin._user_roles", new=AsyncMock(return_value=["operator"])) as roles:
            result = await keycloak_admin.list_users(search="", first=0, max_results=2, token="test-only", db=db,
                actor={"realm_access": {"roles": ["zone-admin"]}})
        self.assertEqual((result["hasMore"], result["nextFirst"]), (False, None))
        self.assertEqual([item["id"] for item in result["items"]], ["inside"])
        roles.assert_awaited_once_with("test-only", "inside")
