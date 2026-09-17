// Live local integration test: create a temporary user, sign in with the
// account-console and frontend Authorization Code + S256 PKCE flows, then delete that user.
// Existing users and credentials are never modified. No tokens are printed.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

const { base, api } = await connectLocalKeycloak();
const realmUrl = `${base}/realms/inout`;
const username = `account-check-${randomBytes(12).toString("hex")}`;
const password = randomBytes(32).toString("base64url");
let userId;
const apiPort = process.env.PYTHON_API_PORT || "1002";
if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535) throw new Error("Invalid local PYTHON_API_PORT");
if (!process.env.KEYCLOAK_CLIENT_SECRET) throw new Error("Set KEYCLOAK_CLIENT_SECRET for the frontend integration check");

async function signIn(clientId = "account-console") {
  const cookies = new Map();
  const request = async (url, init = {}) => {
    assert.equal(new URL(url).origin, base, "Test credentials must stay on the local Keycloak origin");
    const response = await fetch(url, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { ...init.headers, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const delimiter = pair.indexOf("=");
      const name = pair.slice(0, delimiter);
      if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, pair.slice(delimiter + 1));
    }
    return response;
  };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const redirectUri = clientId === "account-console" ? `${realmUrl}/account/` :
    `${(process.env.AUTH_URL || `http://localhost:${process.env.APP_PORT || "1008"}`).replace(/\/$/, "")}/api/auth/callback/keycloak`;
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "openid profile email", state, nonce: randomBytes(16).toString("hex"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    prompt: "login",
  });
  const loginPage = await request(`${realmUrl}/protocol/openid-connect/auth?${params}`);
  assert.equal(loginPage.status, 200, "OIDC authorization must present the login form");
  const html = await loginPage.text();
  const form = html.match(/<form\b[^>]*id="kc-form-login"[^>]*>/i)?.[0];
  const action = form?.match(/action="([^"]+)"/i)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(action, "Expected the built-in Keycloak password form");
  const authenticated = await request(action, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password, credentialId: "" }),
  });
  assert.equal(authenticated.status, 302, "The temporary user must finish login without extra required actions");
  const callback = new URL(authenticated.headers.get("location"));
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code, "OIDC authorization must issue a code");
  const response = await fetch(`${realmUrl}/protocol/openid-connect/token`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirectUri,
      ...(clientId === "inout-frontend" ? { client_secret: process.env.KEYCLOAK_CLIENT_SECRET } : {}) }),
  });
  assert.equal(response.status, 200, "PKCE code exchange must succeed");
  return (await response.json()).access_token;
}

try {
  const created = await api("/users", { method: "POST", body: {
    username, enabled: true, firstName: "Account", lastName: "Integration Check",
    email: `${username}@example.invalid`, emailVerified: true, requiredActions: [],
    credentials: [{ type: "password", value: password, temporary: false }],
  } });
  const location = created.headers.get("location");
  if (location) userId = new URL(location).pathname.split("/").pop();
  else userId = (await (await api(`/users?username=${username}&exact=true`)).json())[0]?.id;
  assert.ok(userId, "Created test user ID must be available for cleanup");

  // Reproduce the affected users: retain only the application role, with no
  // default-roles-inout assignment to supply account access implicitly.
  const inheritedDefaults = await (await api(`/users/${userId}/role-mappings/realm`)).json();
  if (inheritedDefaults.length) await api(`/users/${userId}/role-mappings/realm`, { method: "DELETE", body: inheritedDefaults });
  for (const roleName of ["operator", "admin"]) {
    const role = await (await api(`/roles/${roleName}`)).json();
    await api(`/users/${userId}/role-mappings/realm`, { method: "POST", body: [role] });
    const accessToken = await signIn();
    for (const path of ["/account/supportedLocales", "/account/?userProfileMetadata=true"]) {
      const response = await fetch(`${realmUrl}${path}`, {
        signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      assert.equal(response.status, 200, `${roleName} account API failed: ${path}`);
      await response.json();
      console.log(`${roleName}: ${path} -> HTTP 200`);
    }
    const adminApi = await fetch(`${base}/admin/realms/inout/users`, {
      signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.ok([401, 403].includes(adminApi.status), "Self-service token must not grant Keycloak administration");
    const frontendToken = await signIn("inout-frontend");
    for (const [path, expectedStatus] of [
      ["/v1/checkpoints", roleName === "admin" ? 200 : 403],
      ["/v1/terminal/bundle", roleName === "operator" ? 200 : 403],
    ]) {
      const response = await fetch(`http://localhost:${apiPort}${path}`, {
        signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${frontendToken}` },
      });
      assert.equal(response.status, expectedStatus, `${roleName} frontend API access failed: ${path}`);
      await response.json();
      console.log(`${roleName}: ${path} -> HTTP ${expectedStatus}`);
    }
    await api(`/users/${userId}/role-mappings/realm`, { method: "DELETE", body: [role] });
  }
} finally {
  if (userId) {
    await api(`/users/${userId}`, { method: "DELETE" });
    console.log("Temporary account test user removed.");
  }
}
