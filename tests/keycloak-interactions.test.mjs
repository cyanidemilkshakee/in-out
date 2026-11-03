import assert from "node:assert/strict";
import { test } from "node:test";
import { configureInteractions, retireNativePasswordClient } from "../scripts/configure-keycloak-interactions.mjs";
import { interactionProviderReady } from "../scripts/keycloak-interaction-access.mjs";

function fixture() {
  const state = { client: { id: "frontend", clientId: "inout-frontend", enabled: true, publicClient: false,
    protocol: "openid-connect", standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: true,
    serviceAccountsEnabled: false, redirectUris: ["https://app.fixture/api/auth/callback/keycloak"],
    attributes: { custom: "preserved", "pkce.code.challenge.method": "S256" } },
    native: { id: "native", clientId: "inout-password-updates", enabled: true, secret: "synthetic-preserved" },
    realm: { loginTheme: "keycloak.v2" }, policies: { policies: [], globalPolicies: [] }, writes: [], probes: 0 };
  state.api = async (path, { method = "GET", body } = {}) => {
    if (path === "/clients?clientId=inout-frontend") return Response.json([state.client]);
    if (path === "/clients?clientId=inout-password-updates") return Response.json(state.native ? [state.native] : []);
    if (path === "/clients/frontend/client-secret") return Response.json({ value: "synthetic-frontend-secret" });
    if (path === "/client-policies/policies?include-global-policies=true") return Response.json(state.policies);
    const document = path === "/clients/frontend" ? state.client : path === "/clients/native" ? state.native : path === "" ? state.realm : undefined;
    if (!document) throw new Error("Unexpected fixture path: " + path);
    if (method !== "GET") { state.writes.push({ path, body: structuredClone(body) }); Object.assign(document, structuredClone(body)); }
    return Response.json(document);
  };
  state.providerReady = async () => { state.probes++; return true; };
  state.configure = options => configureInteractions(state.api, { log() {}, providerReady: state.providerReady, ...options });
  return state;
}

test("interaction check is read-only and verifies provider readiness", async () => {
  const state = fixture();
  assert.equal(await state.configure(), false);
  assert.equal(state.probes, 1);
  assert.deepEqual(state.writes, []);
});

test("interaction apply disables password grants and preserves secrets, browser callbacks and unrelated attributes", async () => {
  const state = fixture();
  assert.equal(await state.configure({ apply: true }), true);
  assert.equal(state.client.directAccessGrantsEnabled, false);
  assert.equal(state.client.attributes["inout.app-interactions.enabled"], "true");
  assert.equal(state.client.attributes.custom, "preserved");
  assert.equal(state.client.standardFlowEnabled, true);
  assert.equal(state.native.enabled, true, "The old app may still need the native client before rollout");
  assert.ok(!state.writes.some(write => write.body.secret));
  state.writes.length = 0;
  assert.equal(await state.configure({ apply: true }), true);
  assert.deepEqual(state.writes, []);
});

test("retirement requires explicit request after a verified interaction configuration", async () => {
  const state = fixture();
  await state.configure({ apply: true });
  assert.equal(await state.configure({ retireNative: true }), false);
  assert.equal(state.native.enabled, true);
  state.writes.length = 0;
  assert.equal(await state.configure({ apply: true, retireNative: true }), true);
  assert.deepEqual(state.writes, [{ path: "/clients/native", body: { enabled: false } }]);
  assert.equal(state.native.secret, "synthetic-preserved");
  state.writes.length = 0;
  assert.equal(await state.configure({ apply: true, retireNative: true }), true);
  assert.deepEqual(state.writes, []);
});

test("provider failure prevents client changes and native-client retirement", async () => {
  const state = fixture();
  await assert.rejects(state.configure({ apply: true, retireNative: true, providerReady: async () => false }), /Verify the installed/);
  assert.deepEqual(state.writes, []);
  assert.equal(state.native.enabled, true);
});

test("retirement preserves absent clients and rejects ambiguous identities", async () => {
  const state = fixture();
  state.native = null;
  assert.equal(await retireNativePasswordClient(state.api, { apply: true }), true);
  await assert.rejects(retireNativePasswordClient(async () => Response.json([
    { clientId: "inout-password-updates", id: "one" }, { clientId: "inout-password-updates", id: "two" },
  ]), { apply: true }), /Ambiguous/);
});

test("readiness authenticates the existing client and checks exact extension/protocol/provider versions", async () => {
  const state = fixture();
  const expected = { extensionVersion: 1, keycloakVersion: "26.8.0", protocol: "inout-app-interactions-v1" };
  const probe = body => interactionProviderReady(state.api, "http://auth.localhost:1009", state.client, async (url, options) => {
    assert.equal(url, "http://auth.localhost:1009/realms/inout/inout-auth/status");
    assert.equal(options.headers.Authorization, "Basic " + Buffer.from("inout-frontend:synthetic-frontend-secret").toString("base64"));
    assert.equal(options.method, "GET");
    return Response.json(body);
  });
  assert.equal(await probe(expected), true);
  for (const body of [{ ...expected, extensionVersion: 2 }, { ...expected, keycloakVersion: "26.7.0" },
    { ...expected, protocol: "other" }, { ...expected, extensionVersion: "1" }]) {
    await assert.rejects(probe(body), /does not match/);
  }
});

test("unavailable, oversized and non-JSON readiness responses fail closed", async () => {
  const state = fixture();
  for (const response of [new Response(null, { status: 404 }), new Response("x".repeat(4097)), new Response("not json")]) {
    await assert.rejects(interactionProviderReady(state.api, "http://auth.localhost:1009", state.client, async () => response));
  }
  assert.deepEqual(state.writes, []);
});

test("enabled realm or global client policies block cutover and retirement before any write", async () => {
  for (const policies of [
    { policies: [{ name: "realm-rule", enabled: true }], globalPolicies: [] },
    { policies: [], globalPolicies: [{ name: "other-client-rule", enabled: true }] },
  ]) {
    const state = fixture();
    state.policies = policies;
    const providerReady = client => interactionProviderReady(state.api, "http://auth.localhost:1009", client, async () =>
      Response.json({ extensionVersion: 1, keycloakVersion: "26.8.0", protocol: "inout-app-interactions-v1" }));
    await assert.rejects(state.configure({ apply: true, retireNative: true, providerReady }), /Enabled realm\/global OAuth client policies/);
    assert.deepEqual(state.writes, []);
    assert.equal(state.client.directAccessGrantsEnabled, true);
    assert.equal(state.native.enabled, true);
    assert.deepEqual(state.policies, policies);
  }
});

test("disabled policies are compatible and malformed policy responses fail closed", async () => {
  const state = fixture();
  const probe = () => interactionProviderReady(state.api, "http://auth.localhost:1009", state.client, async () =>
    Response.json({ extensionVersion: 1, keycloakVersion: "26.8.0", protocol: "inout-app-interactions-v1" }));
  state.policies = { policies: [{ enabled: false }], globalPolicies: [{ name: "disabled-by-default" }] };
  assert.equal(await probe(), true);
  for (const policies of [null, [], {}, { policies: "invalid" }, { policies: [], globalPolicies: {} },
    { policies: [null] }, { policies: [{ enabled: "true" }] }]) {
    state.policies = policies;
    await assert.rejects(probe(), /Invalid OAuth client-policy/);
  }
  assert.deepEqual(state.writes, []);
});
