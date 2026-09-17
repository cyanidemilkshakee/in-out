import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { missingAccountRoles, missingApiAudienceMapper } from "../scripts/keycloak-account-access.mjs";

const clientId = "account-client-id";
const roles = ["manage-account", "view-profile", "delete-account"].map((name) => ({ id: `id-${name}`, name, clientRole: true, containerId: clientId }));

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

test("fresh realm users inherit account access through either application role", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  for (const name of ["admin", "operator"]) {
    const role = realm.roles.realm.find((candidate) => candidate.name === name);
    assert.equal(role.composite, true);
    assert.deepEqual(role.composites, { client: { account: ["manage-account", "view-profile"] } });
  }
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
