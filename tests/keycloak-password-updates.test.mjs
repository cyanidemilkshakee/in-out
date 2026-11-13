import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configurePasswordUpdates, passwordUpdateClientReady, PASSWORD_UPDATE_CLIENT_ID } from "../scripts/setup-keycloak.mjs";

const secret = "synthetic-password-update-secret-00000000000000";

function fixture({ existing = false, clientOverrides = {}, serviceRoles = [], managementRoles = [], permissionIds = false } = {}) {
  const state = {
    realm: { realm: "inout", adminPermissionsEnabled: false, smtpServer: { host: "preserved.fixture" } },
    client: existing ? { id: "service-client", clientId: PASSWORD_UPDATE_CLIENT_ID,
      enabled: true, protocol: "openid-connect", publicClient: false, clientAuthenticatorType: "client-secret",
      serviceAccountsEnabled: true, fullScopeAllowed: false, standardFlowEnabled: false,
      directAccessGrantsEnabled: false, implicitFlowEnabled: false, redirectUris: [], webOrigins: [],
      customPreservedSetting: "preserved", ...clientOverrides } : null,
    secret, serviceRoles, managementRoles, policy: null, permission: null, writes: [], logs: [], ignorePermissions: false,
  };
  const clone = value => structuredClone(value);
  const answer = value => Response.json(clone(value));
  state.api = async (path, { method = "GET", body } = {}) => {
    if (method !== "GET") state.writes.push({ path, method, body: clone(body) });
    const url = new URL("https://admin.fixture" + (path || "/"));
    if (!path) {
      if (method === "PUT") Object.assign(state.realm, clone(body));
      return answer(state.realm);
    }
    if (url.pathname === "/clients" && method === "GET") {
      const id = url.searchParams.get("clientId");
      return answer(id === PASSWORD_UPDATE_CLIENT_ID ? state.client ? [state.client] : []
        : id === "realm-management" ? [{ id: "management-client", clientId: id }]
        : id === "admin-permissions" && state.realm.adminPermissionsEnabled ? [{ id: "permissions-client", clientId: id }] : []);
    }
    if (path === "/clients" && method === "POST") {
      state.client = { ...clone(body), id: "service-client" };
      state.secret = state.client.secret;
      return new Response(null, { status: 201 });
    }
    if (path === "/clients/service-client") {
      if (method === "PUT") Object.assign(state.client, clone(body));
      return answer(state.client);
    }
    if (path === "/clients/service-client/client-secret") return answer({ value: state.secret });
    if (path === "/clients/service-client/service-account-user") {
      assert.equal(state.client.serviceAccountsEnabled, true);
      return answer({ id: "service-user", username: `service-account-${PASSWORD_UPDATE_CLIENT_ID}` });
    }
    if (path === "/users/service-user/role-mappings/realm/composite") return answer(state.serviceRoles);
    if (path === "/users/service-user/role-mappings/clients/management-client/composite") return answer(state.managementRoles);
    const base = "/clients/permissions-client/authz/resource-server";
    if (url.pathname === base + "/scope") return answer([
      { id: "view-scope", name: "view" }, { id: "reset-scope", name: "reset-password" }, { id: "manage-scope", name: "manage" },
    ]);
    if (url.pathname === base + "/policy" && method === "GET") return answer(state.policy ? [state.policy] : []);
    if (url.pathname.startsWith(base + "/policy/user")) {
      if (method !== "GET") state.policy = { ...clone(body), id: "service-policy" };
      return answer(state.policy);
    }
    if (url.pathname === base + "/permission/scope" && method === "GET") return answer(state.permission ? [state.permission] : []);
    if (url.pathname.startsWith(base + "/permission/scope")) {
      if (url.pathname.endsWith("/resources")) return answer(state.permission.resources.length
        ? state.permission.resources.map(id => ({ id, name: id })) : [{ id: "all-users-resource", name: "Users" }]);
      if (url.pathname.endsWith("/associatedPolicies")) return answer(state.permission.policies.map(id => ({ id })));
      if (method !== "GET" && !state.ignorePermissions) {
        state.permission = { ...clone(body), id: "service-permission" };
        if (permissionIds) state.permission.scopes = state.permission.scopes.map(name => name === "view" ? "view-scope" : "reset-scope");
      }
      if (!state.permission) return new Response(null, { status: 204 });
      // Match Keycloak's typed provider: associations are not included, and
      // scope IDs are returned only when fields=* was explicitly requested.
      const { scopes, policies, resources, ...representation } = state.permission;
      return answer({ ...representation, ...(url.searchParams.get("fields") === "*" ? { scopes } : {}) });
    }
    throw new Error(`Unexpected synthetic administration request: ${method} ${path}`);
  };
  state.configure = options => configurePasswordUpdates(state.api, { clientSecret: secret, log: message => state.logs.push(message), ...options });
  return state;
}

test("password-update check reports missing configuration without creating a client", async () => {
  const state = fixture();
  assert.equal(await state.configure(), false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.client, null);
});

test("native password updates provision a separate closed client with only view/reset authority", async () => {
  const state = fixture();
  assert.equal(await state.configure({ apply: true }), true);
  assert.equal(passwordUpdateClientReady(state.client), true);
  assert.deepEqual(state.policy.users, ["service-user"]);
  assert.equal(state.policy.logic, "POSITIVE");
  assert.equal(state.permission.resourceType, "Users");
  assert.deepEqual(state.permission.scopes, ["view", "reset-password"]);
  assert.deepEqual(state.permission.policies, ["service-policy"]);
  assert.deepEqual(state.permission.resources, []);
  assert.equal(state.permission.decisionStrategy, "UNANIMOUS");
  assert.equal(state.realm.smtpServer.host, "preserved.fixture");
  assert.ok(!state.writes.some(write => /role-mappings|reset-password|\/users\/[^/]+$/.test(write.path)));
  const created = state.writes.find(write => write.path === "/clients");
  assert.equal(created.body.enabled, false, "A new service remains disabled while its policy is being provisioned");
  assert.equal(state.writes.at(-1).path, "/clients/service-client");
  assert.deepEqual(state.writes.at(-1).body, { enabled: true });
  assert.ok(!state.logs.join(" ").includes(secret));
});

test("configured native password updates are idempotent in both check and apply modes", async () => {
  for (const permissionIds of [false, true]) {
    const state = fixture({ permissionIds });
    await state.configure({ apply: true });
    state.writes.length = 0;
    assert.equal(await state.configure(), true);
    assert.equal(await state.configure({ apply: true }), true);
    assert.deepEqual(state.writes, []);
  }
});

test("repair preserves unrelated client settings and does not rotate its secret", async () => {
  const state = fixture({ existing: true, clientOverrides: { standardFlowEnabled: true, redirectUris: ["https://obsolete.fixture/callback"] } });
  assert.equal(await state.configure(), false);
  assert.deepEqual(state.writes, []);
  assert.equal(await state.configure({ apply: true }), true);
  assert.equal(state.client.customPreservedSetting, "preserved");
  assert.equal(state.secret, secret);
  assert.ok(!state.writes.some(write => write.body?.secret));
  assert.deepEqual(state.client.redirectUris, []);
});

test("existing secret mismatch fails before any provider writes", async () => {
  const state = fixture({ existing: true });
  state.secret = "synthetic-provider-secret-mismatch-0000000000";
  await assert.rejects(state.configure({ apply: true }), /does not match/);
  assert.deepEqual(state.writes, []);
  assert.ok(!state.logs.join(" ").includes(state.secret));
});

test("the password-update client cannot be public or another protocol", async () => {
  for (const clientOverrides of [{ publicClient: true }, { protocol: "saml" }]) {
    const state = fixture({ existing: true, clientOverrides });
    await assert.rejects(state.configure({ apply: true }), /dedicated confidential/);
    assert.deepEqual(state.writes, []);
  }
});

test("service accounts with application or admin roles are rejected without granting permissions", async () => {
  for (const options of [{ serviceRoles: [{ name: "zone-admin" }] }, { serviceRoles: [{ name: "master-admin" }] },
    { managementRoles: [{ name: "manage-users" }] }, { managementRoles: [{ name: "view-users" }] }]) {
    const state = fixture({ existing: true, ...options });
    await assert.rejects(state.configure({ apply: true }), /unexpected application or administration roles/);
    assert.deepEqual(state.writes, []);
  }
});

test("owned permission drift is repaired without modifying other realm users or privileges", async () => {
  const state = fixture();
  await state.configure({ apply: true });
  state.permission.scopes.push("manage");
  state.writes.length = 0;
  assert.equal(await state.configure(), false);
  assert.deepEqual(state.writes, []);
  assert.equal(await state.configure({ apply: true }), true);
  assert.deepEqual(state.permission.scopes, ["view", "reset-password"]);
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0].path, /\/permission\/scope\/service-permission$/);
});

test("configuration name collisions fail rather than replacing administrator policies", async () => {
  const state = fixture();
  await state.configure({ apply: true });
  state.policy.description = "Administrator managed";
  state.writes.length = 0;
  await assert.rejects(state.configure({ apply: true }), /not owned/);
  assert.deepEqual(state.writes, []);
});

test("a successful HTTP write without persisted authority is not reported configured", async () => {
  const state = fixture();
  state.ignorePermissions = true;
  await assert.rejects(state.configure({ apply: true }), /did not persist/);
  assert.equal(state.client.enabled, false);
});

test("weak or absent secrets never reach the administration API", async () => {
  for (const clientSecret of [undefined, "short", "x".repeat(300), "contains spaces but is sufficiently long 000000000000000"]) {
    let contacted = false;
    await assert.rejects(configurePasswordUpdates(async () => { contacted = true; }, { clientSecret, apply: true }), /KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET/);
    assert.equal(contacted, false);
  }
});

test("the legacy native password service is disabled in new realms", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  const client = realm.clients.find(client => client.clientId === PASSWORD_UPDATE_CLIENT_ID);
  assert.equal(client.enabled, false);
  assert.equal(passwordUpdateClientReady({ ...client, enabled: true }), true);
  assert.equal(client.secret, "${KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET}");
  assert.equal(client.defaultClientScopes, undefined);
});
