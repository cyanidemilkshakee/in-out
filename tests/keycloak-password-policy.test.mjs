import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_PASSWORD_POLICY, configurePasswordPolicy, securePasswordPolicy } from "../scripts/configure-keycloak-password-policy.mjs";

function fixture(passwordPolicy) {
  const state = { passwordPolicy, smtpServer: { host: "preserved.fixture" } };
  const writes = [];
  const api = async (path, options = {}) => {
    assert.equal(path, "");
    if (options.method === "PUT") { writes.push(options.body); Object.assign(state, options.body); }
    return Response.json(state);
  };
  return { state, writes, api };
}

test("fresh realm enforces length, identity exclusions and a bundled common-password denylist", () => {
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  assert.equal(realm.passwordPolicy, APP_PASSWORD_POLICY);
  assert.match(APP_PASSWORD_POLICY, /length\(12\)/);
  const words = readFileSync(new URL("../keycloak/password-blacklists/inout-common-passwords.txt", import.meta.url), "utf8").split("\n");
  assert.ok(words.includes("password123456"));
  assert.match(readFileSync(new URL("../keycloak/Dockerfile", import.meta.url), "utf8"), /COPY password-blacklists\/ \/opt\/keycloak\/data\/password-blacklists\//);
});

test("policy repair preserves stronger length and administrator security requirements", () => {
  const policy = securePasswordPolicy("length(24) and digits(2) and passwordHistory(5) and passwordBlacklist(company.txt)");
  assert.equal(policy, "length(24) and digits(2) and passwordHistory(5) and passwordBlacklist(company.txt) and notUsername(undefined) and notEmail(undefined)");
  assert.equal(securePasswordPolicy(policy), policy);
  assert.equal(securePasswordPolicy("length(3)"), APP_PASSWORD_POLICY);
});

test("check is read-only; apply changes only passwordPolicy and verifies it", async () => {
  const state = fixture("");
  assert.equal(await configurePasswordPolicy(state.api, { log() {} }), false);
  assert.deepEqual(state.writes, []);
  assert.equal(await configurePasswordPolicy(state.api, { apply: true, log() {} }), true);
  assert.deepEqual(state.writes, [{ passwordPolicy: APP_PASSWORD_POLICY }]);
  assert.deepEqual(state.state.smtpServer, { host: "preserved.fixture" });
  assert.equal(await configurePasswordPolicy(state.api, { apply: true, log() {} }), true);
  assert.equal(state.writes.length, 1);
});

test("policy repair fails if the provider did not retain the update", async () => {
  await assert.rejects(configurePasswordPolicy(async () => Response.json({ passwordPolicy: "" }), { apply: true, log() {} }), /did not persist/);
});
