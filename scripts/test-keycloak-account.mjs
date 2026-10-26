// Live local integration test: create a temporary user, sign in with the
// account-console and frontend Authorization Code + S256 PKCE flows, then delete that user.
// Existing users and credentials are never modified. No tokens are printed.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { connectLocalKeycloak, localKeycloakRequest, missingFrontendRoleClaims } from "./keycloak-account-access.mjs";

const { base, api } = await connectLocalKeycloak();
const realmUrl = `${base}/realms/inout`;
const username = `account-check-${randomBytes(12).toString("hex")}`;
const password = randomBytes(32).toString("base64url");
let userId;
const apiPort = process.env.PYTHON_API_PORT || "1002";
if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535) throw new Error("Invalid local PYTHON_API_PORT");
if (!process.env.KEYCLOAK_CLIENT_SECRET) throw new Error("Set KEYCLOAK_CLIENT_SECRET for the frontend integration check");
const jwksResponse = await localKeycloakRequest(`${realmUrl}/protocol/openid-connect/certs`, { signal: AbortSignal.timeout(15_000) });
assert.equal(jwksResponse.status, 200);
const jwks = createLocalJWKSet(await jwksResponse.json());

async function signIn(clientId = "account-console") {
  const cookies = new Map();
  const request = async (url, init = {}) => {
    assert.equal(new URL(url).origin, base, "Test credentials must stay on the local Keycloak origin");
    const response = await localKeycloakRequest(url, {
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
  const response = await localKeycloakRequest(`${realmUrl}/protocol/openid-connect/token`, {
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
  for (const roleName of ["admin", "operator"]) {
    const role = await (await api(`/roles/${roleName}`)).json();
    await api(`/users/${userId}/role-mappings/realm`, { method: "POST", body: [role] });
    const accessToken = await signIn();
    for (const path of ["/account/supportedLocales", "/account/?userProfileMetadata=true"]) {
      const response = await localKeycloakRequest(`${realmUrl}${path}`, {
        signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      assert.equal(response.status, 200, `${roleName} account API failed: ${path}`);
      await response.json();
      console.log(`${roleName}: ${path} -> HTTP 200`);
    }
    const adminApi = await localKeycloakRequest(`${base}/admin/realms/inout/users`, {
      signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(adminApi.status, 404, "Public identity listener must block Keycloak administration for every token");
    const frontendToken = await signIn("inout-frontend");
    const { payload } = await jwtVerify(frontendToken, jwks, {
      algorithms: ["RS256"], issuer: realmUrl, audience: process.env.KEYCLOAK_AUDIENCE || "inout-frontend",
    });
    assert.equal(payload.sub, userId);
    assert.deepEqual(missingFrontendRoleClaims(payload, [roleName]), [], "Explicit frontend scopes must retain all required application permissions");
    if (roleName === "operator") {
      assert.equal(payload.resource_access?.["realm-management"]?.roles?.includes("manage-users") || false, false,
        "Operator tokens must not contain delegated user administration");
    }
    const adminEndpoints = [
      "/v1/alerts?limit=1", "/v1/registry/subjects?kind=employee&limit=1", "/v1/alert-rule-assignments",
    ];
    const requests = roleName === "admin" ? Array.from({ length: 6 }, () => adminEndpoints).flat() : adminEndpoints;
    const statuses = await Promise.all(requests.map(async (path) => {
      const response = await fetch(`http://localhost:${apiPort}${path}`, {
        signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${frontendToken}` },
      });
      assert.equal(response.status, roleName === "admin" ? 200 : 403, `${roleName} parallel API check failed: ${path}`);
      assert.equal(response.headers.get("X-RateLimit-Limit-Minute"), "300",
        "Real signed account requests must pass Kong's verified-credential limiter");
      await response.json();
      return response.status;
    }));
    console.log(`${roleName}: scoped signed token and ${statuses.length} parallel admin-page API checks -> HTTP ${roleName === "admin" ? 200 : 403}`);
    for (const [path, expectedStatus] of [
      ["/v1/checkpoints", roleName === "admin" ? 200 : 403],
      // Both supported application roles can operate the terminal.
      ["/v1/terminal/bundle", 200],
    ]) {
      const response = await fetch(`http://localhost:${apiPort}${path}`, {
        signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${frontendToken}` },
      });
      assert.equal(response.status, expectedStatus, `${roleName} frontend API access failed: ${path}`);
      assert.equal(response.headers.get("X-RateLimit-Limit-Minute"), "300");
      await response.json();
      console.log(`${roleName}: ${path} -> HTTP ${expectedStatus}`);
    }
    await api(`/users/${userId}/role-mappings/realm`, { method: "DELETE", body: [role] });
  }
  const privateCallback = await fetch(`http://localhost:${apiPort}/internal/gateway/identity`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
  });
  assert.equal(privateCallback.status, 404, "Kong's identity callback must stay private");
} finally {
  if (userId) {
    await api(`/users/${userId}`, { method: "DELETE" });
    console.log("Temporary account test user removed.");
  }
}
