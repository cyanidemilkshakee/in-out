import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configureMasterAdmin } from "../scripts/configure-keycloak-master-admin.mjs";

function response(payload) {
  return { json: async () => structuredClone(payload) };
}

test("master-admin provisioning is idempotent and never grants a user or changes client grants", async () => {
  const roles = [{ id: "admin-id", name: "admin" }];
  const composites = new Map();
  const mappings = [{ id: "admin-id", name: "admin" }, { id: "operator-id", name: "operator" }];
  const writes = [];
  const api = async (path, { method = "GET", body } = {}) => {
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "/roles" && method === "GET") return response(roles);
    if (path === "/roles" && method === "POST") {
      roles.push({ id: "master-id", name: body.name });
      return response(null);
    }
    if (path === "/roles/master-admin/composites" && method === "GET") return response(composites.get(path) ?? []);
    if (path === "/roles/master-admin/composites" && method === "POST") {
      composites.set(path, [...body]);
      return response(null);
    }
    if (path === "/clients?clientId=inout-frontend") return response([{ id: "frontend-id", clientId: "inout-frontend" }]);
    if (path === "/clients/frontend-id/scope-mappings/realm" && method === "GET") return response(mappings);
    if (path === "/clients/frontend-id/scope-mappings/realm" && method === "POST") {
      mappings.push(...body);
      return response(null);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };

  assert.deepEqual(await configureMasterAdmin(api, { apply: true }), {
    ready: true, roleExists: true, adminComposite: true, frontendScope: true,
  });
  assert.equal(writes.length, 3);
  assert.ok(writes.every(({ path }) => !path.startsWith("/users")));
  assert.ok(writes.every(({ path }) => !path.includes("directAccessGrantsEnabled")));
  assert.deepEqual(await configureMasterAdmin(api), {
    ready: true, roleExists: true, adminComposite: true, frontendScope: true,
  });
  assert.equal(writes.length, 3);
});

test("realm template exposes master-admin only to frontend and preserves access-grant settings", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  const master = realm.roles.realm.find((role) => role.name === "master-admin");
  assert.deepEqual(master.composites.realm, ["admin"]);
  assert.deepEqual(realm.scopeMappings.find(({ client }) => client === "inout-frontend").roles,
    ["admin", "operator", "master-admin"]);
  assert.deepEqual(realm.scopeMappings.find(({ client }) => client === "inout-postman").roles,
    ["admin", "operator"]);
  assert.equal(realm.clients.find(({ clientId }) => clientId === "inout-frontend").directAccessGrantsEnabled, true);
  assert.equal(realm.clients.find(({ clientId }) => clientId === "inout-postman").directAccessGrantsEnabled, false);
});
