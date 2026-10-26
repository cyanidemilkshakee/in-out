import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  configureKeycloakAudit,
  EVENT_RETENTION_SECONDS,
  keycloakAuditReady,
  keycloakAuditSettings,
  REQUIRED_USER_EVENT_TYPES,
} from "../scripts/configure-keycloak-audit.mjs";

const template = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));

function fakeApi(initial) {
  const state = structuredClone(initial);
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === "PUT") Object.assign(state, options.body);
    return { json: async () => structuredClone(state) };
  };
  return { api, calls, state };
}

test("new realm template enables bounded audit events without changing client grants", () => {
  assert.equal(template.eventsEnabled, true);
  assert.equal(template.eventsExpiration, EVENT_RETENTION_SECONDS);
  assert.equal(template.attributes.adminEventsExpiration, String(EVENT_RETENTION_SECONDS));
  assert.equal(template.adminEventsEnabled, true);
  assert.equal(template.adminEventsDetailsEnabled, false);
  assert.ok(REQUIRED_USER_EVENT_TYPES.every((event) => template.enabledEventTypes.includes(event)));
  assert.equal(template.clients.find((client) => client.clientId === "inout-frontend").directAccessGrantsEnabled, true);
});

test("audit settings preserve longer retention and existing selected event types", () => {
  const settings = keycloakAuditSettings({ eventsExpiration: 90 * 24 * 60 * 60,
    enabledEventTypes: ["LOGIN", "CUSTOM_EVENT"], attributes: { adminEventsExpiration: "7776000", keep: "value" } });
  assert.equal(settings.eventsExpiration, 90 * 24 * 60 * 60);
  assert.equal(settings.attributes.adminEventsExpiration, "7776000");
  assert.equal(settings.attributes.keep, "value");
  assert.ok(settings.enabledEventTypes.includes("CUSTOM_EVENT"));
  assert.ok(REQUIRED_USER_EVENT_TYPES.every((event) => settings.enabledEventTypes.includes(event)));
  assert.equal(settings.adminEventsDetailsEnabled, false);
});

test("all-event selection remains all-event selection", () => {
  assert.deepEqual(keycloakAuditSettings({ eventsEnabled: true, enabledEventTypes: [] }).enabledEventTypes, []);
});

test("check mode reports drift without writing", async () => {
  const state = fakeApi({ eventsEnabled: false, eventsExpiration: 0, enabledEventTypes: [],
    adminEventsEnabled: false, adminEventsDetailsEnabled: true, attributes: {} });
  const messages = [];
  assert.equal(await configureKeycloakAudit(state.api, { log: (message) => messages.push(message) }), false);
  assert.equal(state.calls.filter((call) => call.options.method === "PUT").length, 0);
  assert.match(messages[0], /needs configuration/);
});

test("apply mode updates only realm event settings and verifies them", async () => {
  const state = fakeApi({ eventsEnabled: false, eventsExpiration: 0, enabledEventTypes: ["CUSTOM_EVENT"],
    adminEventsEnabled: false, adminEventsDetailsEnabled: true,
    attributes: { preserve: "existing" },
    clients: [{ clientId: "inout-frontend", directAccessGrantsEnabled: true }] });
  assert.equal(await configureKeycloakAudit(state.api, { apply: true, log() {} }), true);
  const update = state.calls.find((call) => call.options.method === "PUT");
  assert.equal(update.path, "");
  assert.deepEqual(Object.keys(update.options.body).sort(), [
    "adminEventsDetailsEnabled", "adminEventsEnabled", "attributes", "enabledEventTypes", "eventsEnabled", "eventsExpiration",
  ].sort());
  assert.equal(state.state.attributes.preserve, "existing");
  assert.equal(state.state.clients[0].directAccessGrantsEnabled, true);
  assert.equal(keycloakAuditReady(state.state), true);
});

test("apply fails if Keycloak does not persist the requested settings", async () => {
  const api = async () => ({ json: async () => ({}) });
  await assert.rejects(configureKeycloakAudit(api, { apply: true, log() {} }), /did not confirm/);
});
