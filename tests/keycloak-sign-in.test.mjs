import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applicationSignInReady, configureApplicationSignIn } from "../scripts/configure-keycloak-app-sign-in.mjs";

function fixture(overrides = {}) {
  const original = { id: "frontend-id", clientId: "inout-frontend", enabled: true, publicClient: false,
    protocol: "openid-connect", standardFlowEnabled: false, implicitFlowEnabled: true,
    directAccessGrantsEnabled: false, serviceAccountsEnabled: true,
    secret: "synthetic-preserved-secret", redirectUris: ["https://app.fixture/callback"],
    webOrigins: ["https://app.fixture"], protocolMappers: [{ name: "custom-preserved-mapper" }],
    attributes: { custom: "preserved", "post.logout.redirect.uris": "https://app.fixture/logout" }, ...overrides };
  const client = structuredClone(original);
  const realm = { realm: "inout", loginTheme: "inout", resetPasswordAllowed: true, smtpServer: { host: "smtp.fixture" } };
  const writes = [];
  const logs = [];
  const api = async (path, { method = "GET", body } = {}) => {
    if (path === "/clients?clientId=inout-frontend") return Response.json([{ id: client.id, clientId: client.clientId }]);
    if (path === "") {
      if (method === "PUT") { writes.push(structuredClone(body)); Object.assign(realm, body); }
      return Response.json(realm);
    }
    assert.equal(path, "/clients/frontend-id", "The repair must only address the frontend client");
    if (method === "PUT") { writes.push(structuredClone(body)); Object.assign(client, body); }
    return Response.json(client);
  };
  return { original, client, realm, writes, logs, api, log: message => logs.push(message) };
}

test("application sign-in check reports missing settings without modifying them", async () => {
  const state = fixture();
  assert.equal(await configureApplicationSignIn(state.api, { log: state.log }), false);
  assert.deepEqual(state.client, state.original);
  assert.equal(state.writes.length, 0);
  assert.equal(state.realm.loginTheme, "inout");
  assert.ok(!state.logs.join(" ").includes(state.original.secret));
});

test("application repair enables its form and stock setup, preserving provider settings", async () => {
  const state = fixture();
  assert.equal(await configureApplicationSignIn(state.api, { apply: true, log: state.log }), true);
  assert.equal(applicationSignInReady(state.client), true);
  assert.deepEqual(state.writes, [{ standardFlowEnabled: true, implicitFlowEnabled: false,
    directAccessGrantsEnabled: true, serviceAccountsEnabled: false,
    attributes: { ...state.original.attributes, "pkce.code.challenge.method": "S256" } }, { loginTheme: "keycloak.v2" }]);
  for (const field of ["secret", "redirectUris", "webOrigins", "protocolMappers"]) assert.deepEqual(state.client[field], state.original[field]);
  assert.equal(await configureApplicationSignIn(state.api, { apply: true, log: state.log }), true);
  assert.equal(state.writes.length, 2, "A repeated repair must not rewrite the client or realm");
  assert.deepEqual(state.realm, { realm: "inout", loginTheme: "keycloak.v2", resetPasswordAllowed: true,
    smtpServer: { host: "smtp.fixture" } });
  assert.ok(!state.logs.join(" ").includes(state.original.secret));
});

test("already configured application sign-in performs no writes", async () => {
  const state = fixture({ standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: true,
    serviceAccountsEnabled: false, attributes: { "pkce.code.challenge.method": "S256" } });
  state.realm.loginTheme = "keycloak.v2";
  assert.equal(await configureApplicationSignIn(state.api, { apply: true, log: state.log }), true);
  assert.deepEqual(state.writes, []);
});

test("removing only the previous realm login leaves an already configured client untouched", async () => {
  const state = fixture({ standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: true,
    serviceAccountsEnabled: false, attributes: { "pkce.code.challenge.method": "S256" } });
  assert.equal(await configureApplicationSignIn(state.api, { apply: true, log: state.log }), true);
  assert.deepEqual(state.writes, [{ loginTheme: "keycloak.v2" }]);
  assert.deepEqual(state.client, state.original);
});

test("browser repair rejects public, disabled and non-OIDC clients before mutation", async () => {
  for (const overrides of [{ publicClient: true }, { enabled: false }, { protocol: "saml" }]) {
    const state = fixture(overrides);
    await assert.rejects(configureApplicationSignIn(state.api, { apply: true, log: state.log }), /enabled confidential/);
    assert.deepEqual(state.writes, []);
  }
});

test("browser repair rejects absent or ambiguous clients", async () => {
  for (const clients of [[], [{ id: "a", clientId: "inout-frontend" }, { id: "b", clientId: "inout-frontend" }]]) {
    const api = async (_path, options) => { assert.equal(options, undefined); return Response.json(clients); };
    await assert.rejects(configureApplicationSignIn(api, { apply: true, log() {} }), /Exactly one/);
  }
});

test("provider success without persisted S256 policy is not reported as repaired", async () => {
  const state = fixture();
  const api = async (path, options) => {
    if (options?.method === "PUT") return new Response(null, { status: 204 });
    return state.api(path, options);
  };
  await assert.rejects(configureApplicationSignIn(api, { apply: true, log() {} }), /did not confirm/);
});

test("new realms enable the confidential application form while Postman remains code-only", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  const app = realm.clients.find(client => client.clientId === "inout-frontend");
  assert.equal(applicationSignInReady(app), true);
  assert.equal(realm.loginTheme, undefined, "New realms must use Keycloak's built-in fallback");
  for (const clientId of ["inout-frontend", "inout-postman"]) {
    const client = realm.clients.find(candidate => candidate.clientId === clientId);
    assert.equal(client.directAccessGrantsEnabled, clientId === "inout-frontend");
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  }
});

test("repair removes a client branding override without replacing unrelated attributes", async () => {
  const state = fixture({ attributes: { login_theme: "inout", custom: "preserved" } });
  await configureApplicationSignIn(state.api, { apply: true, log: state.log });
  assert.equal(state.client.attributes.login_theme, "keycloak.v2");
  assert.equal(state.client.attributes.custom, "preserved");
});

test("repair does not replace an unrelated administrator-managed fallback theme", async () => {
  const state = fixture();
  state.realm.loginTheme = "another-provider-theme";
  await configureApplicationSignIn(state.api, { apply: true, log: state.log });
  assert.equal(state.realm.loginTheme, "another-provider-theme");
  assert.equal(state.writes.length, 1);
});
