// Run after npm run build. Starts an isolated app with synthetic sessions and
// local identity/API stubs; never contacts the configured real Keycloak realm.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { encode, decode } from "next-auth/jwt";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const secret = randomBytes(32).toString("base64url");
const cookieName = "authjs.session-token";
const intentCookieName = "inout_user_management_step_up";
const lockCookieName = "inout_user_management_step_up_lock";
const stepUpDurations = [5, 10, 15, 20, 30, 60];
const accessToken = (role) => `header.${Buffer.from(JSON.stringify({ realm_access: { roles: [role] } })).toString("base64url")}.signature`;
let refreshCalls = 0;
const upstreamTokens = [];
const terminalTokens = [];
const identityRequests = [];
const authorizationCodes = new Map();
const { privateKey, publicKey } = await generateKeyPair("RS256");
const signingKey = { ...await exportJWK(publicKey), kid: "synthetic-test-key", alg: "RS256", use: "sig" };
let codeExchanges = 0;
let callbackAuthTime;
let callbackAccessToken;
// Large synthetic claims reproduce a realm with many roles/groups. Both the
// bearer and refresh token remain below each upstream's request-header limit;
// their encrypted Auth.js session plus OAuth cookies exceeds Node's 16 KiB default.
const largeRefreshToken = randomBytes(2100).toString("base64url");

async function largeAdminAccessToken() {
  return new SignJWT({ realm_access: { roles: ["admin"] },
    groups: Array.from({ length: 120 }, (_, index) => `/synthetic-group-${index}-${"x".repeat(38)}`) })
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject("test-user")
    .setIssuedAt().setExpirationTime("10m").sign(privateKey);
}

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, upstreamUrl);
  if (url.pathname === "/realms/inout/protocol/openid-connect/auth") {
    assert.equal(url.searchParams.get("client_id"), "inout-frontend");
    assert.equal(url.searchParams.get("prompt"), "login");
    assert.equal(url.searchParams.get("max_age"), "0");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("state") && url.searchParams.get("nonce"));
    const code = randomBytes(24).toString("base64url");
    authorizationCodes.set(code, {
      redirectUri: url.searchParams.get("redirect_uri"), nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
    });
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: callback.href }).end();
    return;
  }
  if (req.url === "/v1/presence/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(': heartbeat\n\n');
    return;
  }
  if (req.url === "/v1/terminal/scans") {
    req.socket.destroy(); // Simulate an unavailable API, not a validation error.
    return;
  }
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/realms/inout/.well-known/openid-configuration") {
    const issuer = `${upstreamUrl}/realms/inout`;
    res.end(JSON.stringify({ issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
    }));
    return;
  }
  if (url.pathname === "/realms/inout/protocol/openid-connect/certs") {
    res.end(JSON.stringify({ keys: [signingKey] }));
    return;
  }
  if (req.url === "/realms/inout/protocol/openid-connect/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    if (params.get("grant_type") === "authorization_code") {
      const grant = authorizationCodes.get(params.get("code"));
      authorizationCodes.delete(params.get("code"));
      assert.ok(grant, "The synthetic code must exist and be used only once");
      assert.equal(params.get("redirect_uri"), grant.redirectUri);
      assert.ok(createHash("sha256").update(params.get("code_verifier")).digest("base64url") === grant.challenge,
        "The real callback must complete its PKCE check");
      codeExchanges++;
      callbackAuthTime = Math.floor(Date.now() / 1000);
      callbackAccessToken = await largeAdminAccessToken();
      const idToken = await new SignJWT({ nonce: grant.nonce, auth_time: callbackAuthTime,
        name: "Test user", email: "test@example.invalid" })
        .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject("test-user")
        .setIssuer(`${upstreamUrl}/realms/inout`).setAudience("inout-frontend")
        .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      res.end(JSON.stringify({ access_token: callbackAccessToken, refresh_token: largeRefreshToken,
        id_token: idToken, expires_in: 600, token_type: "Bearer" }));
      return;
    }
    refreshCalls++;
    if (params.get("refresh_token") === "revoked") {
      res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const role = params.get("refresh_token") === "operator-refresh" ? "operator" : "admin";
    res.end(JSON.stringify({ access_token: accessToken(role), refresh_token: `${role}-refresh`, expires_in: 300, token_type: "Bearer" }));
    return;
  }
  if (req.url === "/v1/admin/profile") {
    upstreamTokens.push(req.headers.authorization);
    res.end(JSON.stringify({ id: "test-profile", name: "Test user", email: "test@example.invalid" }));
    return;
  }
  if (req.url === "/v1/admin/profile/availability" && req.method === "PATCH") {
    for await (const _chunk of req) { /* Drain the sign-in availability update. */ }
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/v1/keycloak/users" || req.url.startsWith("/v1/keycloak/users?") || req.url.startsWith("/v1/keycloak/users/")) {
    identityRequests.push({ authorization: req.headers.authorization, proof: req.headers["x-inout-step-up"], method: req.method });
    for await (const _chunk of req) { /* Drain synthetic command bodies. */ }
    res.end(JSON.stringify(req.method === "GET" ? { items: [], first: 0, max: 50 } : { ok: true }));
    return;
  }
  if (req.url === "/v1/terminal/bundle") {
    terminalTokens.push(req.headers.authorization);
    const checkpointId = req.headers.authorization === `Bearer ${accessToken("operator")}` ? "cp-main" : null;
    res.end(JSON.stringify({
      hardwareAssets: [], movements: [], permissionRequests: [],
      checkpoints: checkpointId ? [{ id: "cp-main", name: "Main Entrance", zone: "public", mode: "auto" }] : [],
      terminalAssignment: { operatorSubject: "test-user", checkpointId },
      adminAvailability: { status: "available", availableAt: null },
    }));
    return;
  }
  res.writeHead(404).end(JSON.stringify({ detail: "Unexpected test upstream request" }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
// NextRequest normalizes loopback IPs to localhost; match that canonical origin
// so Auth.js's same-origin callback validation follows the real browser flow.
const appUrl = `http://localhost:${port}`;

const app = spawn(process.execPath, ["--max-http-header-size=65536", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, AUTH_URL: appUrl, AUTH_SECRET: secret, AUTH_TRUST_HOST: "true",
    KEYCLOAK_CLIENT_ID: "inout-frontend", KEYCLOAK_CLIENT_SECRET: "test-client-secret",
    KEYCLOAK_ISSUER: `${upstreamUrl}/realms/inout`, KEYCLOAK_ISSUER_PUBLIC: `${upstreamUrl}/realms/inout`,
    KEYCLOAK_JWKS_BASE: `${upstreamUrl}/realms/inout`, PYTHON_API_URL: upstreamUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
// Consume logs without printing cookies, tokens, or request diagnostics.
app.stdout.resume();
app.stderr.resume();
let diagnostics = "";
app.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8000); });
let startupError;
app.on("error", (error) => { startupError = error; });

async function sessionCookie(overrides = {}) {
  const token = { sub: "test-user", name: "Test user", provider: "keycloak", roles: ["admin"],
    access_token: accessToken("admin"), refresh_token: "admin-refresh", expires_at: 1, ...overrides };
  return `${cookieName}=${await encode({ token, secret, salt: cookieName })}`;
}

function updatedCookie(response) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
  assert.ok(cookie, "Auth.js must persist the updated token in the response cookie");
  return cookie.split(";")[0];
}

function request(path, cookie, options = {}) {
  // Native HTTP allows the same bounded response-header size as the app. The
  // built-in fetch client independently caps the combined chunked Set-Cookie
  // headers at 16 KiB even though each browser cookie fits its own 4 KiB limit.
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${appUrl}${path}`, { method: options.method || "GET",
      headers: { ...(cookie ? { cookie } : {}), ...options.headers }, maxHeaderSize: 65536, family: 4,
      signal: AbortSignal.timeout(20_000) }, (res) => {
      const headers = new Headers();
      for (let index = 0; index < res.rawHeaders.length; index += 2) {
        headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
      }
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function chunkedSessionJar(cookie) {
  const value = cookie.slice(cookieName.length + 1);
  const jar = new Map();
  // Match Auth.js's browser-safe 4096 - 160 byte cookie chunk size.
  for (let index = 0; index * 3936 < value.length; index++) {
    jar.set(`${cookieName}.${index}`, value.slice(index * 3936, (index + 1) * 3936));
  }
  return jar;
}

function applyResponseCookies(jar, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1));
  }
}

const jarHeader = (jar) => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

function assertLargeCookieHeader(jar) {
  const bytes = Buffer.byteLength(jarHeader(jar));
  assert.ok(bytes > 16 * 1024 && bytes < 32 * 1024,
    "Regression cookies must exceed Node's old 16 KiB limit and fit the gateway's 32 KiB limit");
  const chunks = [...jar].filter(([name]) => name.startsWith(`${cookieName}.`));
  assert.ok(chunks.length >= 5, "Use realistic browser cookie chunking for the large session");
  assert.ok(chunks.every(([, value]) => value.length <= 3936), "Every session chunk must fit a browser cookie");
}

async function startSyntheticLogin(jar) {
  const csrf = await request("/api/auth/csrf", jarHeader(jar));
  assert.equal(csrf.status, 200);
  applyResponseCookies(jar, csrf);
  const { csrfToken } = await csrf.json();
  const signin = await request("/api/auth/signin/keycloak?prompt=login&max_age=0", jarHeader(jar), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${appUrl}/admin/users` }).toString(),
  });
  assert.equal(signin.status, 200);
  applyResponseCookies(jar, signin);
  for (const name of ["authjs.state", "authjs.pkce.code_verifier", "authjs.nonce"]) {
    assert.ok(jar.has(name), "Sign-in must issue actual encrypted OAuth check cookies");
  }
  assertLargeCookieHeader(jar);
  const authorization = await fetch((await signin.json()).url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  assert.equal(authorization.status, 302);
  return new URL(authorization.headers.get("location"));
}

function stepUpRequest(cookie, body, headers = {}) {
  return request("/api/auth/step-up", cookie, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: appUrl, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) });
}

function responseCookie(response, name) {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`) && !/^\w[\w-]*=;/.test(cookie));
  assert.ok(value, `Expected the ${name} response cookie`);
  return value;
}

function signedPayload(value, purpose) {
  assert.ok(typeof value === "string", "A server-signed value is required");
  const parts = value.split(".");
  assert.equal(parts.length, 2, "Signed values must contain a payload and signature");
  const expected = createHmac("sha256", secret).update(purpose + parts[0]).digest();
  const actual = Buffer.from(parts[1], "base64url");
  assert.ok(actual.length === expected.length && timingSafeEqual(actual, expected), "The server signature must match the isolated test secret");
  return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
}

function assertDurationSelect(html, selected, expectedLabel) {
  const label = html.match(/<label\b[^>]*class="[^"]*\bidentity-duration-select\b[^"]*"[^>]*>[\s\S]*?<\/label>/)?.[0];
  assert.ok(label, "The duration selector must have a visible associated label");
  if (expectedLabel) assert.equal(label.match(/<span\b[^>]*>([^<]*)<\/span>/)?.[1], expectedLabel);
  const options = [...label.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attributes, text]) => ({
    value: Number(attributes.match(/\bvalue="(\d+)"/)?.[1]), text, selected: /\bselected(?:=|\s|$)/.test(attributes),
  }));
  assert.deepEqual(options.map((option) => option.value), stepUpDurations);
  assert.deepEqual(options.map((option) => option.text), ["5 minutes", "10 minutes", "15 minutes", "20 minutes", "30 minutes", "1 hour"]);
  assert.deepEqual(options.filter((option) => option.selected).map((option) => option.value), [selected]);
}

async function activeStepUpCookie(durationMinutes, authTime = Math.floor(Date.now() / 1000) - 30, overrides = {}) {
  return sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600,
    auth_time: authTime, step_up_duration_minutes: durationMinutes,
    step_up_expires_at: authTime + durationMinutes * 60, ...overrides });
}

function assertForwardedProof(captured, durationMinutes, authTime, before, after, bearer = accessToken("admin")) {
  assert.ok(captured.authorization === `Bearer ${bearer}`, "Identity calls must forward the signed session's bearer");
  const proof = signedPayload(captured.proof, "inout:user-management-step-up:v1.");
  assert.deepEqual(Object.keys(proof).sort(), ["authTime", "durationMinutes", "expiresAt", "issuedAt", "tokenHash"]);
  assert.equal(proof.durationMinutes, durationMinutes);
  assert.equal(proof.authTime, authTime);
  assert.equal(proof.expiresAt, authTime + durationMinutes * 60);
  assert.ok(Number.isInteger(proof.issuedAt) && proof.issuedAt >= Math.floor(before / 1000) && proof.issuedAt <= Math.floor(after / 1000));
  assert.ok(proof.tokenHash === createHash("sha256").update(bearer).digest("hex"), "The proof must bind the exact forwarded bearer");
}

async function assertIdentityBlocked(cookie, expectedStatus = 403, options = {}, expectedCode = "STEP_UP_REQUIRED") {
  const before = identityRequests.length;
  const response = await request("/api/keycloak", cookie, options);
  assert.equal(response.status, expectedStatus);
  assert.equal(identityRequests.length, before, "Rejected identity requests must not contact the identity upstream");
  if (expectedCode && expectedStatus === 403 && (!options.method || options.method === "GET")) {
    assert.equal((await response.json()).code, expectedCode);
  }
  return response;
}

try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (app.exitCode !== null) throw new Error("Isolated Next.js test server exited before readiness");
    try {
      if ((await request("/api/auth/session")).ok) { ready = true; break; }
    } catch { /* Wait for the owned test process to become ready. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Isolated app readiness timed out");
  assert.equal((await request("/api/profile")).status, 401);
  assert.equal(new URL((await request("/account")).headers.get("location"), appUrl).pathname, "/login");
  assert.equal(new URL((await request("/terminal")).headers.get("location"), appUrl).pathname, "/login");

  const response = await request("/api/profile", await sessionCookie());
  assert.equal(response.status, 200);
  assert.equal(refreshCalls, 1, "API wrapper and upstream helper must share a single refresh");
  assert.equal(upstreamTokens.at(-1), `Bearer ${accessToken("admin")}`);
  const cookie = updatedCookie(response);
  const decoded = await decode({ token: cookie.slice(cookie.indexOf("=") + 1), secret, salt: cookieName });
  assert.ok(decoded.expires_at > Date.now() / 1000);

  const publicSession = await (await request("/api/auth/session", cookie)).json();
  assert.deepEqual(publicSession.roles, ["admin"]);
  for (const name of ["access_token", "refresh_token", "id_token"]) {
    assert.equal(JSON.stringify(publicSession).includes(name), false, `Public session leaked ${name}`);
  }
  assert.equal((await request("/api/profile", cookie)).status, 200);
  assert.equal(refreshCalls, 1, "Persisted refreshed cookie should not need another refresh");
  const account = await request("/account", cookie);
  assert.equal(account.headers.get("location"), `${upstreamUrl}/realms/inout/account/`);
  const page = await request("/admin/profile", cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  // Admin account actions are mounted after opening the sidebar menu. HTTP
  // rendering can verify its accessible trigger, but cannot exercise that click.
  assert.ok(html.includes('aria-label="Profile settings"') && html.includes('aria-label="Open account menu"'));
  assert.ok(html.includes('href="/terminal"'), "Administrators must have a terminal navigation link");
  const adminTerminal = await request("/terminal", cookie);
  assert.equal(adminTerminal.status, 200, "Administrators must be allowed to view the terminal");
  const adminTerminalHtml = await adminTerminal.text();
  assert.ok(adminTerminalHtml.includes("Account security") && adminTerminalHtml.includes("Sign out"));
  assert.ok(adminTerminalHtml.includes('href="/admin/users"'), "Administrator terminal menu must link to user management");
  assert.ok(adminTerminalHtml.includes("No checkpoint assigned"), "An unassigned administrator must not inherit an operator checkpoint");
  assert.equal(terminalTokens.at(-1), `Bearer ${accessToken("admin")}`);

  const denied = await request("/api/profile", await sessionCookie({ refresh_token: "revoked" }));
  assert.equal(denied.status, 401);
  const revokedCookie = updatedCookie(denied);
  const attempts = refreshCalls;
  assert.equal((await request("/api/profile", revokedCookie)).status, 401);
  assert.equal(refreshCalls, attempts, "Invalid refresh grants must not be retried after invalidation is persisted");

  const operator = await sessionCookie({ roles: ["operator"], access_token: accessToken("operator"), expires_at: Math.floor(Date.now() / 1000) + 300 });
  assert.equal((await request("/account", operator)).headers.get("location"), `${upstreamUrl}/realms/inout/account/`);
  const redirected = await request("/admin/profile", operator);
  assert.equal(new URL(redirected.headers.get("location")).pathname, "/terminal");
  const operatorTerminal = await request("/terminal", operator);
  assert.equal(operatorTerminal.status, 200);
  const operatorTerminalHtml = await operatorTerminal.text();
  assert.ok(operatorTerminalHtml.includes("Assigned checkpoint") && operatorTerminalHtml.includes("Main Entrance"));
  assert.ok(operatorTerminalHtml.includes("Account security") && operatorTerminalHtml.includes("Sign out"));
  assert.equal(operatorTerminalHtml.includes('href="/admin/users"'), false, "Operator terminal menu must not offer user management");
  const terminalSnapshot = await request("/api/data?scope=terminal", operator);
  assert.equal(terminalSnapshot.status, 200);
  const terminalData = (await terminalSnapshot.json()).data;
  assert.deepEqual(terminalData.terminalAssignment, { operatorSubject: "test-user", checkpointId: "cp-main" });
  assert.deepEqual(terminalData.checkpoints.map((checkpoint) => checkpoint.id), ["cp-main"]);
  assert.equal(terminalTokens.at(-1), `Bearer ${accessToken("operator")}`);

  const freshAdmin = await sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600 });
  const lockedPage = await request("/admin/users", freshAdmin);
  assert.equal(lockedPage.status, 200);
  const lockedHtml = await lockedPage.text();
  assert.ok(lockedHtml.includes("Manage users is locked") && lockedHtml.includes("Unlock user management"));
  assertDurationSelect(lockedHtml, 5);
  await assertIdentityBlocked(freshAdmin);
  await assertIdentityBlocked(undefined, 401);
  await assertIdentityBlocked(operator, 403, {}, null);

  assert.equal((await stepUpRequest(undefined, { durationMinutes: 5 })).status, 401);
  assert.equal((await stepUpRequest(operator, { durationMinutes: 5 })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: "https://untrusted.example.invalid" })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: "null" })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: `${appUrl}/path` })).status, 403);
  assert.equal((await request("/api/auth/step-up", freshAdmin, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"durationMinutes":5}' })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { "Content-Type": "text/plain" })).status, 415);
  for (const body of ["", "{", "null", "[]", "5", "true", {}, { durationMinutes: null },
    { durationMinutes: "5" }, { durationMinutes: true }, { durationMinutes: 0 },
    { durationMinutes: 6 }, { durationMinutes: 45 }, { durationMinutes: 61 },
    { durationMinutes: 5.5 }, { durationMinutes: 5, unexpected: true }]) {
    const invalid = await stepUpRequest(freshAdmin, body);
    assert.equal(invalid.status, 400, "Invalid re-authentication duration/body must be rejected");
    assert.equal(invalid.headers.getSetCookie().some((value) => value.startsWith(`${intentCookieName}=`)), false);
  }

  for (const durationMinutes of stepUpDurations) {
    const beforeIntent = Date.now();
    const start = await stepUpRequest(freshAdmin, { durationMinutes });
    assert.equal(start.status, 200);
    const intentCookie = responseCookie(start, intentCookieName);
    assert.ok(/;\s*HttpOnly\b/i.test(intentCookie) && /;\s*SameSite=Lax\b/i.test(intentCookie));
    const intent = signedPayload(intentCookie.split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v1.");
    assert.deepEqual(Object.keys(intent).sort(), ["durationMinutes", "issuedAt"]);
    assert.equal(intent.durationMinutes, durationMinutes);
    assert.ok(Number.isSafeInteger(intent.issuedAt) && intent.issuedAt >= beforeIntent && intent.issuedAt <= Date.now());

    // Longer choices remain eligible after the former fixed five-minute window.
    const authTime = Math.floor(Date.now() / 1000) - (durationMinutes === 5 ? 30 : 6 * 60);
    const active = await activeStepUpCookie(durationMinutes, authTime);
    const beforeCall = Date.now();
    const count = identityRequests.length;
    const users = await request("/api/keycloak", active, { headers: { "X-InOut-Step-Up": "forged-incoming-proof" } });
    assert.equal(users.status, 200);
    assert.equal(identityRequests.length, count + 1);
    assertForwardedProof(identityRequests.at(-1), durationMinutes, authTime, beforeCall, Date.now());
    assert.deepEqual((await users.json()).data.items, []);
    const management = await request("/admin/users", active);
    assert.equal(management.status, 200);
    const managementHtml = await management.text();
    assert.ok(managementHtml.includes("Re-authentication active"));
    const extendControls = managementHtml.match(/<div\b[^>]*class="identity-step-up-refresh"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.ok(extendControls, "Unlocked user management must render its extension controls");
    const extendButton = [...extendControls.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .find(([, , contents]) => contents.replace(/<[^>]*>/g, "").trim() === "Extend");
    assert.ok(extendButton && /\btype="button"/.test(extendButton[1]) && !/\bdisabled(?:=|\s|$)/.test(extendButton[1]), "The extension controls must include an enabled Extend button");
    assertDurationSelect(extendControls, durationMinutes, "Extend for");
    const selectedSession = await (await request("/api/auth/session", active)).json();
    assert.equal(selectedSession.authTime, authTime);
    assert.equal(selectedSession.stepUpDurationMinutes, durationMinutes);
    assert.equal(selectedSession.stepUpExpiresAt, authTime + durationMinutes * 60);
    assert.equal(JSON.stringify(selectedSession).includes("tokenHash"), false, "Server proof data must not enter the public session");
    // Matching exact expiry is required even when an attacker supplies a future value.
    await assertIdentityBlocked(await activeStepUpCookie(durationMinutes, Math.floor(Date.now() / 1000) - durationMinutes * 60));
  }

  const stepUpNow = Math.floor(Date.now() / 1000);
  for (const invalid of [
    { auth_time: undefined }, { auth_time: "invalid" }, { auth_time: stepUpNow + 60, step_up_expires_at: stepUpNow + 60 + 3600 },
    { auth_time: stepUpNow - 30.5, step_up_expires_at: stepUpNow - 30.5 + 3600 },
    { step_up_duration_minutes: undefined }, { step_up_duration_minutes: "60" },
    { step_up_duration_minutes: 45 }, { step_up_duration_minutes: 60.5 },
    { step_up_expires_at: undefined }, { step_up_expires_at: String(stepUpNow + 3600) },
    { step_up_expires_at: stepUpNow + 7200 },
  ]) await assertIdentityBlocked(await activeStepUpCookie(60, stepUpNow - 30, invalid));

  const longAuthTime = Math.floor(Date.now() / 1000) - 6 * 60;
  const longSession = await activeStepUpCookie(60, longAuthTime);
  const beforeMutation = Date.now();
  const identityMutation = await request("/api/keycloak", longSession, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: appUrl },
    body: JSON.stringify({ action: "endSessions", userId: "synthetic-user" }) });
  assert.equal(identityMutation.status, 200);
  assert.equal(identityRequests.at(-1).method, "POST");
  assertForwardedProof(identityRequests.at(-1), 60, longAuthTime, beforeMutation, Date.now());
  await assertIdentityBlocked(longSession, 403, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.example.invalid" },
    body: JSON.stringify({ action: "endSessions", userId: "synthetic-user" }) });

  const lock = await request("/api/auth/step-up", longSession, { method: "DELETE", headers: { Origin: appUrl } });
  assert.equal(lock.status, 200);
  assert.equal((await lock.json()).locked, true);
  const lockCookie = responseCookie(lock, lockCookieName);
  assert.ok(Number(lockCookie.match(/\bMax-Age=(\d+)/i)?.[1]) >= 3600, "The lock must outlast every selected window");
  assert.ok(/;\s*HttpOnly\b/i.test(lockCookie) && /;\s*SameSite=Lax\b/i.test(lockCookie));
  const lockedSession = `${longSession}; ${lockCookie.split(";")[0]}`;
  await assertIdentityBlocked(lockedSession);
  const reloadedLocked = await request("/admin/users", lockedSession);
  assert.ok((await reloadedLocked.text()).includes("Manage users is locked"), "Reload must preserve a manual lock within a long active window");
  const renew = await stepUpRequest(lockedSession, { durationMinutes: 10 });
  assert.equal(renew.status, 200);
  const pendingLock = responseCookie(renew, lockCookieName);
  assert.ok(Number(pendingLock.match(/\bMax-Age=(\d+)/i)?.[1]) >= 3600);
  const pendingSession = `${longSession}; ${pendingLock.split(";")[0]}; ${responseCookie(renew, intentCookieName).split(";")[0]}`;
  await assertIdentityBlocked(pendingSession);
  assert.ok((await (await request("/admin/users", pendingSession)).text()).includes("Manage users is locked"), "Canceling a new sign-in must not restore an old active window");
  const unchangedSession = await (await request("/api/auth/session", pendingSession)).json();
  assert.equal(unchangedSession.stepUpExpiresAt, longAuthTime + 3600, "Starting a new sign-in must not silently extend the old expiry");
  assert.equal(unchangedSession.stepUpDurationMinutes, 60);

  const largeJar = chunkedSessionJar(await sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600,
    access_token: await largeAdminAccessToken(), refresh_token: largeRefreshToken }));
  assertLargeCookieHeader(largeJar);
  assert.equal((await request("/api/profile", jarHeader(largeJar))).status, 200,
    "Protected admin API requests must accept a large, valid chunked session");
  const largeLockedPage = await request("/admin/users", jarHeader(largeJar));
  assert.equal(largeLockedPage.status, 200);
  assert.ok((await largeLockedPage.text()).includes("Manage users is locked"));
  await assertIdentityBlocked(jarHeader(largeJar));
  const largeOperator = chunkedSessionJar(await sessionCookie({ roles: ["operator"],
    access_token: accessToken("operator"), refresh_token: randomBytes(13_000).toString("base64url"),
    expires_at: Math.floor(Date.now() / 1000) + 600 }));
  assertLargeCookieHeader(largeOperator);
  assert.equal((await stepUpRequest(jarHeader(largeOperator), { durationMinutes: 15 })).status, 403,
    "Large cookies must preserve the administrator-only unlock check");
  await assertIdentityBlocked(jarHeader(largeOperator), 403, {}, null);

  let completedChunkCount;
  for (const durationMinutes of [15, 30]) {
    assertLargeCookieHeader(largeJar);
    const start = await stepUpRequest(jarHeader(largeJar), { durationMinutes });
    assert.equal(start.status, 200, "A realistic large Cookie header must reach the step-up handler without HTTP 431");
    applyResponseCookies(largeJar, start);
    await assertIdentityBlocked(jarHeader(largeJar));
    const callbackUrl = await startSyntheticLogin(largeJar);
    const exchangesBeforeCallback = codeExchanges;

    // An invalid state must remain a controlled authentication error with the
    // same large cookies and cannot exchange the code or clear the manual lock.
    const invalidUrl = new URL(callbackUrl);
    invalidUrl.searchParams.set("state", "invalid-synthetic-state");
    const invalidJar = new Map(largeJar);
    const invalidCallback = await request(invalidUrl.pathname + invalidUrl.search, jarHeader(invalidJar));
    assert.equal(invalidCallback.status, 302);
    const errorDestination = new URL(invalidCallback.headers.get("location"), appUrl);
    assert.ok(errorDestination.searchParams.has("error") && errorDestination.pathname !== "/admin/users",
      "Invalid OAuth state must redirect to an authentication error, not return 431 or finish the unlock");
    assert.equal(codeExchanges, exchangesBeforeCallback, "Rejected state must never reach the token endpoint");
    applyResponseCookies(invalidJar, invalidCallback);
    assert.ok(invalidJar.has(lockCookieName) && invalidJar.has(intentCookieName));
    await assertIdentityBlocked(jarHeader(invalidJar));

    assertLargeCookieHeader(largeJar);
    const completed = await request(callbackUrl.pathname + callbackUrl.search, jarHeader(largeJar));
    assert.equal(completed.status, 302);
    assert.equal(completed.headers.get("location"), `${appUrl}/admin/users`, "Fresh OIDC callback must return to Manage users");
    assert.equal(codeExchanges, exchangesBeforeCallback + 1);
    applyResponseCookies(largeJar, completed);
    for (const name of [intentCookieName, lockCookieName, "authjs.state", "authjs.pkce.code_verifier", "authjs.nonce"]) {
      assert.equal(largeJar.has(name), false, "A completed callback must remove its temporary OAuth and step-up cookies");
    }
    assertLargeCookieHeader(largeJar);
    const sessionChunks = [...largeJar.keys()].filter((name) => name.startsWith(`${cookieName}.`)).sort();
    assert.deepEqual(sessionChunks, sessionChunks.map((_, index) => `${cookieName}.${index}`),
      "Callback session chunks must stay contiguous without stale higher-numbered chunks");
    assert.equal(largeJar.has(cookieName), false, "A chunked session must not retain an obsolete unchunked cookie");
    if (completedChunkCount !== undefined) assert.equal(sessionChunks.length, completedChunkCount,
      "Repeated successful re-authentication must replace chunks instead of growing stale session cookies");
    completedChunkCount = sessionChunks.length;
    const completedSession = await (await request("/api/auth/session", jarHeader(largeJar))).json();
    assert.deepEqual(completedSession.roles, ["admin"]);
    assert.equal(completedSession.authTime, callbackAuthTime);
    assert.equal(completedSession.stepUpDurationMinutes, durationMinutes);
    assert.equal(completedSession.stepUpExpiresAt, callbackAuthTime + durationMinutes * 60);
    for (const name of ["access_token", "refresh_token", "id_token"]) {
      assert.equal(JSON.stringify(completedSession).includes(name), false, "Large public sessions must still hide all provider tokens");
    }
    const beforeCall = Date.now();
    const unlockedUsers = await request("/api/keycloak", jarHeader(largeJar));
    assert.equal(unlockedUsers.status, 200, "The callback's verified fresh authentication must unlock the identity API");
    assertForwardedProof(identityRequests.at(-1), durationMinutes, callbackAuthTime, beforeCall, Date.now(), callbackAccessToken);
    const unlockedPage = await request("/admin/users", jarHeader(largeJar));
    assert.equal(unlockedPage.status, 200);
    assert.ok((await unlockedPage.text()).includes("Re-authentication active"));
  }
  assert.equal((await request("/api/health", `oversized=${"x".repeat(66_000)}`)).status, 431,
    "Headers beyond the explicit 64 KiB bound must still be rejected");

  const encrypted = longSession.slice(cookieName.length + 1);
  const alteredPosition = Math.floor(encrypted.length / 2);
  const altered = encrypted.slice(0, alteredPosition) + (encrypted[alteredPosition] === "a" ? "b" : "a") + encrypted.slice(alteredPosition + 1);
  await assertIdentityBlocked(`${cookieName}=${altered}`, 401);

  const stream = await request("/api/presence", await sessionCookie());
  assert.equal(stream.status, 200);
  updatedCookie(stream);
  const reader = stream.body.getReader();
  assert.ok(new TextDecoder().decode((await reader.read()).value).includes(": heartbeat"));
  await reader.cancel();
  const failedScan = await fetch(`${appUrl}/api/data`, { method: "POST",
    headers: { cookie, "Content-Type": "application/json", Origin: appUrl },
    body: JSON.stringify({ action: "recordScan", input: { barcode: "test", checkpointId: "cp-main" } }),
  });
  assert.equal(failedScan.status, 502, "An upstream connection failure must remain retryable by the offline queue");
  console.log("Keycloak HTTP checks passed: session isolation/refresh, role routing, terminal assignments, six selected re-authentication windows, signed intent/proof forwarding, strict expiry, origin/body denial, lock persistence, canceled renewal, cookie tampering, large chunked-cookie protected routes, two real synthetic OIDC unlock/extension callbacks, rejected OAuth state, temporary-cookie cleanup, stable session chunks, and the 64 KiB header bound.");
} catch (error) {
  // The server uses only synthetic credentials, but redact them even in errors.
  console.error(diagnostics.replaceAll(secret, "[redacted]").replace(/Bearer\s+\S+/g, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted token/cookie]"));
  throw error;
} finally {
  if (app.pid && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill();
    await exited;
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
