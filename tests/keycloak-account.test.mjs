import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyApplicationClientScopes, localKeycloakRequest, missingAccountRoles, missingApiAudienceMapper,
  missingApplicationScopeRoles, missingFrontendRoleClaims, prepareApplicationClientScopes } from "../scripts/keycloak-account-access.mjs";

const clientId = "account-client-id";
const roles = ["manage-account", "view-profile", "delete-account"].map((name) => ({ id: `id-${name}`, name, clientRole: true, containerId: clientId }));

test("local identity commands stay on loopback, preserve the public Host and never follow credential redirects", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: new URL(url), init }); return new Response(); };
  try {
    await localKeycloakRequest("http://auth.localhost:1009/admin/realms/inout/users", {
      headers: { Authorization: "Bearer local-test-token", Host: "attacker.invalid" }, redirect: "follow",
    });
    assert.equal(requests[0].url.origin, "http://127.0.0.1:1009");
    assert.equal(requests[0].url.pathname, "/admin/realms/inout/users");
    assert.equal(requests[0].init.headers.get("Host"), "auth.localhost:1009");
    assert.equal(requests[0].init.headers.get("Authorization"), "Bearer local-test-token");
    assert.equal(requests[0].init.redirect, "manual");
    for (const url of ["http://attacker.invalid/token", "https://auth.localhost:1009/token", "http://user:password@auth.localhost:1009/token"]) {
      assert.throws(() => localKeycloakRequest(url), /credentials must stay/);
    }
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("account repair adds only standard self-service permissions", () => {
  assert.deepEqual(missingAccountRoles([], roles, clientId).map((role) => role.name), ["manage-account", "view-profile"]);
});

test("account repair is idempotent and preserves existing mappings", () => {
  const existing = [roles[0], { id: "unrelated-role", name: "custom" }];
  const before = structuredClone(existing);
  assert.deepEqual(missingAccountRoles(existing, roles, clientId), [roles[1]]);
  assert.deepEqual(existing, before);
  assert.deepEqual(missingAccountRoles(roles, roles, clientId), []);
});

test("same-named realm or other-client roles cannot be used for the repair", () => {
  assert.throws(() => missingAccountRoles([], roles.map((role) => ({ ...role, containerId: "realm-management" })), clientId));
  assert.throws(() => missingAccountRoles([], roles.map((role) => ({ ...role, clientRole: false })), clientId));
});

test("application roles grant self-service access while only admins receive user-management access", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  const admin = realm.roles.realm.find((candidate) => candidate.name === "admin");
  const operator = realm.roles.realm.find((candidate) => candidate.name === "operator");
  assert.equal(admin.composite, true);
  assert.deepEqual(admin.composites, { client: {
    account: ["manage-account", "view-profile"],
    "realm-management": ["manage-users", "query-users", "view-users", "view-realm"],
  } });
  assert.equal(operator.composite, true);
  assert.deepEqual(operator.composites, { client: { account: ["manage-account", "view-profile"] } });
});

test("API audience repair restores the template mapper and is idempotent", () => {
  const mapper = missingApiAudienceMapper([]);
  assert.equal(mapper.config["included.client.audience"], "inout-frontend");
  assert.equal(mapper.config["access.token.claim"], "true");
  assert.equal(mapper.config["id.token.claim"], "false");
  assert.equal(missingApiAudienceMapper([mapper]), null);
  assert.equal(missingApiAudienceMapper([{ ...mapper, name: "existing-custom-name" }]), null);
});

test("API audience repair does not silently replace conflicting custom settings", () => {
  assert.throws(() => missingApiAudienceMapper([{ name: "api-audience", config: {} }]), /conflicting settings/);
});

const appRealmRoles = ["admin", "operator"].map((name) => ({ id: `realm-${name}`, name, clientRole: false, composite: true }));

test("application client templates expose only the supported application roles", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  for (const clientId of ["inout-frontend", "inout-postman"]) {
    assert.equal(realm.clients.find((client) => client.clientId === clientId).fullScopeAllowed, false);
    assert.deepEqual(realm.scopeMappings.find((mapping) => mapping.client === clientId).roles,
      ["admin", "operator"]);
  }
});

test("explicit application role scopes preserve custom mappings and reject same-named client roles", () => {
  const existing = [appRealmRoles[0], { id: "custom", name: "custom", clientRole: false }];
  const before = structuredClone(existing);
  assert.deepEqual(missingApplicationScopeRoles(existing, appRealmRoles), [appRealmRoles[1]]);
  assert.deepEqual(existing, before);
  assert.deepEqual(missingApplicationScopeRoles(appRealmRoles, appRealmRoles), []);
  assert.throws(() => missingApplicationScopeRoles([], appRealmRoles.map((role) => ({ ...role, clientRole: true }))), /Missing application realm role/);
});

test("existing-realm scope repair installs mappings before disabling scope and is idempotent", async () => {
  const clients = ["inout-frontend", "inout-postman"].map((clientId) => ({ id: `id-${clientId}`, clientId, fullScopeAllowed: true,
    secret: "unchanged-client-secret", redirectUris: ["https://app.example.invalid/callback"], attributes: { custom: "preserved" } }));
  const mappings = new Map(clients.map((client) => [client.id, [{ id: "custom", name: "custom", clientRole: false }]]));
  const writes = [];
  const api = async (path, { method = "GET", body } = {}) => {
    if (method !== "GET") writes.push({ path, method, body: structuredClone(body) });
    if (path.startsWith("/roles/")) return Response.json(appRealmRoles.find((role) => path === `/roles/${role.name}`));
    const client = clients.find((candidate) => path.startsWith(`/clients/${candidate.id}`));
    assert.ok(client);
    if (path.endsWith("/scope-mappings/realm")) {
      if (method === "POST") mappings.get(client.id).push(...body);
      return Response.json(mappings.get(client.id));
    }
    if (method === "PUT") Object.assign(client, body);
    return Response.json(client);
  };
  const originalClients = structuredClone(clients);
  await applyApplicationClientScopes(api, await prepareApplicationClientScopes(api, clients));
  assert.deepEqual(writes.map((write) => write.method), ["POST", "POST", "PUT", "PUT"]);
  assert.deepEqual(writes.filter((write) => write.method === "PUT").map((write) => write.body), [{ fullScopeAllowed: false }, { fullScopeAllowed: false }]);
  for (const [index, client] of clients.entries()) {
    assert.deepEqual(client, { ...originalClients[index], fullScopeAllowed: false });
    assert.deepEqual(mappings.get(client.id).map((role) => role.name), ["custom", "admin", "operator"]);
  }
  await applyApplicationClientScopes(api, await prepareApplicationClientScopes(api, clients));
  assert.equal(writes.length, 4, "A second repair must perform no writes");
});

test("failed scope installation leaves full scope enabled", async () => {
  const client = { id: "frontend", clientId: "inout-frontend", fullScopeAllowed: true };
  const methods = [];
  const api = async (path, { method = "GET" } = {}) => {
    methods.push(method);
    if (method === "POST") throw new Error("provider rejected role mappings");
    if (path.startsWith("/roles/")) return Response.json(appRealmRoles.find((role) => path === `/roles/${role.name}`));
    return Response.json([]);
  };
  await assert.rejects(applyApplicationClientScopes(api, await prepareApplicationClientScopes(api, [client])), /provider rejected/);
  assert.equal(methods.includes("PUT"), false);
  assert.equal(client.fullScopeAllowed, true);
});

test("frontend scope validation retains application, account and delegated administrator claims", () => {
  const token = { realm_access: { roles: ["admin", "operator"] }, resource_access: {
    account: { roles: ["manage-account", "view-profile"] },
    "realm-management": { roles: ["manage-users", "query-users", "view-users", "view-realm"] },
  } };
  assert.deepEqual(missingFrontendRoleClaims(token, ["admin"]), []);
  assert.deepEqual(missingFrontendRoleClaims(token, ["operator"]), []);
  const withoutManagement = { ...token, resource_access: { account: token.resource_access.account } };
  assert.deepEqual(missingFrontendRoleClaims(withoutManagement, ["operator"]), []);
  assert.deepEqual(missingFrontendRoleClaims(withoutManagement, ["admin"]), [
    "realm-management:manage-users", "realm-management:query-users", "realm-management:view-users", "realm-management:view-realm",
  ]);
  assert.deepEqual(missingFrontendRoleClaims({}, ["operator"]), ["realm:operator", "account:manage-account", "account:view-profile"]);
});
