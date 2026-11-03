// Explicit disposable fixture only: never loads .env or contacts the app realm.
// Start compose.test.yaml + compose.interactions-test.yaml on 1098/1099 first,
// and configure the interaction extension on the fixture realm.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { updateKeycloakPassword } from "../.test-dist/lib/keycloakPasswordUpdate.js";
import { authenticateKeycloakCredentials, revokeKeycloakRefreshToken } from "../.test-dist/lib/keycloakCredentials.js";

if (process.env.TEST_INTERACTION_FIXTURE !== "1") throw new Error("Set TEST_INTERACTION_FIXTURE=1 for the disposable identity fixture only");
const origin = "http://127.0.0.1:1099";
const config = { issuer: "http://auth.fixture:1014/realms/inout", jwksIssuer: `${origin}/realms/inout`,
  clientId: "inout-frontend", clientSecret: "isolated-keycloak-test-client-secret" };
const request = (path, init = {}) => fetch(origin + path, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
const login = await request("/realms/master/protocol/openid-connect/token", { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    grant_type: "password", client_id: "admin-cli", username: "fixture-master", password: "isolated-keycloak-test-master-password" }) });
assert.equal(login.status, 200);
const master = await login.json();
const admin = async (path, method = "GET", body, token = master.access_token) => request("/admin/realms/inout" + path, {
  method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const created = [];
const options = { withUserLock: async (_subject, operation) => operation() };
const inputFor = (account, extra = {}) => ({ mode: "setup", username: account.username,
  currentPassword: account.password, newPassword: randomBytes(32).toString("base64url"), ...extra });
async function addUser({ actions = ["UPDATE_PASSWORD"], enabled = true, role = "master-admin" } = {}) {
  const account = { username: "native-fixture-" + randomBytes(8).toString("hex"), password: randomBytes(32).toString("base64url") };
  const response = await admin("/users", "POST", { username: account.username, enabled,
    email: account.username + "@example.invalid", emailVerified: true, firstName: "Native", lastName: "Fixture",
    requiredActions: actions, credentials: [{ type: "password", value: account.password, temporary: actions.includes("UPDATE_PASSWORD") }] });
  assert.equal(response.status, 201);
  account.id = response.headers.get("location").split("/").at(-1);
  created.push(account.id);
  const mapping = await (await admin("/roles/" + role)).json();
  assert.equal((await admin(`/users/${account.id}/role-mappings/realm`, "POST", [mapping])).status, 204);
  return account;
}
try {
  const account = await addUser();
  const blockedGrant = await request("/realms/inout/protocol/openid-connect/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      grant_type: "password", client_id: config.clientId, client_secret: config.clientSecret,
      username: account.username, password: account.password }) });
  assert.equal(blockedGrant.status, 400);
  assert.equal((await blockedGrant.json()).error, "unauthorized_client");
  console.log("PASS: normal password grants are disabled; app uses only the installed interaction provider");
  const setup = inputFor(account);
  await assert.rejects(updateKeycloakPassword({ ...setup, currentPassword: "incorrect-fixture-password" }, config, options), { code: "credentials" });
  assert.ok((await (await admin(`/users/${account.id}`)).json()).requiredActions.includes("UPDATE_PASSWORD"));
  await updateKeycloakPassword(setup, config, options);
  const setupUser = await (await admin(`/users/${account.id}`)).json();
  assert.ok(!setupUser.requiredActions.includes("UPDATE_PASSWORD"));
  const proof = await authenticateKeycloakCredentials({ username: account.username, password: setup.newPassword }, config);
  assert.equal(proof.id, account.id);
  await revokeKeycloakRefreshToken(proof.refreshToken, config);
  console.log("PASS: master-admin setup succeeds through provider transaction and sign-in redeems its bound code");

  const change = inputFor(account, { mode: "change", currentPassword: setup.newPassword, expectedSubject: account.id });
  await updateKeycloakPassword(change, config, options);
  const changedProof = await authenticateKeycloakCredentials({ username: account.username, password: change.newPassword }, config);
  assert.equal(changedProof.id, account.id);
  await revokeKeycloakRefreshToken(changedProof.refreshToken, config);
  await assert.rejects(authenticateKeycloakCredentials({ username: account.username, password: setup.newPassword }, config));
  console.log("PASS: normal password change preserves subject and invalidates the old password");

  const target = await addUser();
  const credentialsBefore = await (await admin(`/users/${target.id}/credentials`)).json();
  await assert.rejects(updateKeycloakPassword(inputFor(target, { mode: "change", expectedSubject: account.id }), config, options), { code: "credentials" });
  assert.deepEqual(await (await admin(`/users/${target.id}/credentials`)).json(), credentialsBefore);
  const extraActions = await addUser({ actions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] });
  await assert.rejects(updateKeycloakPassword(inputFor(extraActions), config, options), { code: "credentials" });
  assert.deepEqual((await (await admin(`/users/${extraActions.id}`)).json()).requiredActions.sort(), ["CONFIGURE_TOTP", "UPDATE_PASSWORD"]);
  const disabled = await addUser({ enabled: false });
  await assert.rejects(updateKeycloakPassword(inputFor(disabled), config, options), { code: "credentials" });
  console.log("PASS: wrong subject, disabled account and unrelated required actions cannot mutate credentials");
} finally {
  for (const id of created) assert.equal((await admin(`/users/${id}`, "DELETE")).status, 204);
}
