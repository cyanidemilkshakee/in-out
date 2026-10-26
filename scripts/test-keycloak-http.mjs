// Run after npm run build. Starts an isolated app with synthetic sessions and
// local identity/API stubs; never contacts the configured real Keycloak realm.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, sign } from "node:crypto";
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
const browserSsoCookieName = "inout_browser_sso";
const stepUpDurations = [5, 10, 15, 20, 30, 60];
const cachedAccessTokens = new Map();
const accessToken = (role) => {
  if (!cachedAccessTokens.has(role)) {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: signingKey.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test-user", iss: `${upstreamUrl}/realms/inout`, aud: "inout-frontend",
      azp: "inout-frontend", typ: "Bearer", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
      realm_access: { roles: [role] } })).toString("base64url");
    const value = `${header}.${payload}`;
    cachedAccessTokens.set(role, `${value}.${sign("RSA-SHA256", Buffer.from(value), privateKey).toString("base64url")}`);
  }
  return cachedAccessTokens.get(role);
};
let refreshCalls = 0;
const consumedRotationTokens = new Set();
const logoutRequests = [];
const revocationRequests = [];
const passwordGrants = [];
const availabilityUpdates = [];
let stallAvailability = false;
let limitedApiRoute;
let limitedApiResponseKey = "detail";
const upstreamTokens = [];
const upstreamRequestIds = [];
const terminalTokens = [];
const presenceRequests = [];
const identityRequests = [];
const revokedWindows = new Set();
const authorizationCodes = new Map();
const { privateKey, publicKey } = await generateKeyPair("RS256");
const signingKey = { ...await exportJWK(publicKey), kid: "synthetic-test-key", alg: "RS256", use: "sig" };
let codeExchanges = 0;
let callbackAuthTime;
let callbackAccessToken;
let callbackSessionMismatch = false;
// Large synthetic claims reproduce a realm with many roles/groups. Both the
// bearer and refresh token remain below each upstream's request-header limit;
// their encrypted Auth.js session plus OAuth cookies exceeds Node's 16 KiB default.
const largeRefreshToken = randomBytes(2100).toString("base64url");

let callbackSubject = "test-user";
async function largeAdminAccessToken(subject = "test-user", authTime, sessionId) {
  return new SignJWT({ typ: "Bearer", azp: "inout-frontend", realm_access: { roles: ["admin"] },
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...(sessionId === undefined ? {} : { sid: sessionId }),
    groups: Array.from({ length: 120 }, (_, index) => `/synthetic-group-${index}-${"x".repeat(38)}`) })
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject(subject)
    .setIssuer(`${upstreamUrl}/realms/inout`).setAudience("inout-frontend")
    .setIssuedAt().setExpirationTime("10m").sign(privateKey);
}

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, upstreamUrl);
  if (url.pathname.startsWith("/v1/")) upstreamRequestIds.push({ path: url.pathname, id: req.headers["x-request-id"] });
  if (limitedApiRoute === url.pathname) {
    for await (const _chunk of req) { /* Drain synthetic requests. */ }
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "37" })
      .end(JSON.stringify({ [limitedApiResponseKey]: "Unusual activity limit reached. Try again in 37 seconds." }));
    return;
  }
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
      mismatchedSession: callbackSessionMismatch,
    });
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: callback.href }).end();
    return;
  }
  if (url.pathname === "/realms/inout/protocol/openid-connect/logout") {
    assert.equal(url.searchParams.get("client_id"), "inout-frontend");
    const destination = new URL(url.searchParams.get("post_logout_redirect_uri"));
    assert.equal(destination.origin, appUrl);
    assert.equal(destination.pathname, "/logout/complete");
    destination.searchParams.set("state", url.searchParams.get("state"));
    logoutRequests.push(url.href);
    res.writeHead(302, { Location: destination.href }).end();
    return;
  }
  if (url.pathname === "/v1/presence/stream") {
    presenceRequests.push({ search: url.search, lastId: req.headers["last-event-id"] });
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
    if (params.get("grant_type") === "password") {
      assert.equal(params.get("client_id"), "inout-frontend");
      assert.equal(params.get("client_secret"), "test-client-secret");
      assert.ok(params.get("scope")?.split(" ").includes("openid"));
      const username = params.get("username");
      passwordGrants.push({ username, totp: params.get("totp") });
      if (username === "outage") {
        res.writeHead(503).end(JSON.stringify({ error: "temporarily_unavailable", error_description: "SYNTHETIC_PRIVATE_PROVIDER_DETAIL" }));
        return;
      }
      if (username === "setup-required" || params.get("password") !== "correct-password" ||
        (username === "synthetic-otp" && params.get("totp") !== "123456")) {
        res.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: username === "setup-required"
          ? "Account is not fully set up" : "SYNTHETIC_PRIVATE_PROVIDER_DETAIL" }));
        return;
      }
      const subject = username === "different-admin" ? "different-admin" : "test-user";
      const role = username === "synthetic-operator" ? "operator" : "admin";
      callbackAuthTime = Math.floor(Date.now() / 1000);
      callbackAccessToken = role === "admin" ? await largeAdminAccessToken(subject, callbackAuthTime)
        : await new SignJWT({ typ: "Bearer", azp: "inout-frontend", auth_time: callbackAuthTime, realm_access: { roles: [role] } })
          .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject(subject)
          .setIssuer(`${upstreamUrl}/realms/inout`).setAudience("inout-frontend")
          .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      let bearer = callbackAccessToken;
      if (username === "bad-token") {
        const pieces = bearer.split(".");
        pieces[2] = randomBytes(256).toString("base64url");
        bearer = pieces.join(".");
      }
      const idToken = await new SignJWT({ typ: "ID", azp: "inout-frontend", auth_time: callbackAuthTime, name: "Test user", email: "test@example.invalid" })
        .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject(username === "mixed-subject" ? "other-user" : subject)
        .setIssuer(`${upstreamUrl}/realms/inout`).setAudience("inout-frontend")
        .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      res.end(JSON.stringify({ access_token: bearer, refresh_token: largeRefreshToken,
        id_token: idToken, expires_in: 600, token_type: "Bearer" }));
      return;
    }
    if (params.get("grant_type") === "authorization_code") {
      const grant = authorizationCodes.get(params.get("code"));
      authorizationCodes.delete(params.get("code"));
      assert.ok(grant, "The synthetic code must exist and be used only once");
      assert.equal(params.get("redirect_uri"), grant.redirectUri);
      assert.ok(createHash("sha256").update(params.get("code_verifier")).digest("base64url") === grant.challenge,
        "The real callback must complete its PKCE check");
      codeExchanges++;
      callbackAuthTime = Math.floor(Date.now() / 1000);
      const sessionId = randomUUID();
      callbackAccessToken = await largeAdminAccessToken(callbackSubject, callbackAuthTime, sessionId);
      const idToken = await new SignJWT({ typ: "ID", azp: "inout-frontend", nonce: grant.nonce, auth_time: callbackAuthTime,
        sid: grant.mismatchedSession ? randomUUID() : sessionId,
        name: "Test user", email: "test@example.invalid" })
        .setProtectedHeader({ alg: "RS256", kid: signingKey.kid }).setSubject(callbackSubject)
        .setIssuer(`${upstreamUrl}/realms/inout`).setAudience("inout-frontend")
        .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      res.end(JSON.stringify({ access_token: callbackAccessToken, refresh_token: largeRefreshToken,
        id_token: idToken, expires_in: 600, token_type: "Bearer" }));
      return;
    }
    assert.equal(params.get("grant_type"), "refresh_token", "Only password, code, and refresh grants are allowed in this fixture");
    refreshCalls++;
    const refresh = params.get("refresh_token");
    if (refresh === "revoked" || consumedRotationTokens.has(refresh)) {
      res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const rotates = refresh?.startsWith("rotation-origin-");
    if (rotates) consumedRotationTokens.add(refresh);
    const role = refresh === "operator-refresh" ? "operator" : "admin";
    res.end(JSON.stringify({ access_token: accessToken(role), refresh_token: rotates ? refresh.replace("origin", "next") : `${role}-refresh`, expires_in: 300, token_type: "Bearer" }));
    return;
  }
  if (url.pathname === "/realms/inout/protocol/openid-connect/revoke") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    assert.equal(params.get("client_id"), "inout-frontend");
    assert.equal(params.get("client_secret"), "test-client-secret");
    assert.equal(params.get("token_type_hint"), "refresh_token");
    assert.ok(params.get("token"));
    revocationRequests.push(params.get("token"));
    res.end("{}");
    return;
  }
  if (req.url === "/v1/admin/profile") {
    upstreamTokens.push(req.headers.authorization);
    res.end(JSON.stringify({ id: "test-profile", name: "Test user", email: "test@example.invalid" }));
    return;
  }
  if (req.url === "/v1/admin/profile/availability" && req.method === "PATCH") {
    let body = "";
    for await (const chunk of req) body += chunk;
    availabilityUpdates.push(JSON.parse(body));
    if (stallAvailability) {
      setTimeout(() => res.end(JSON.stringify({ ok: true })), 7_000).unref();
      return;
    }
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/v1/user-management/window" || req.url === "/v1/user-management/lock") {
    const proof = signedPayload(req.headers["x-inout-step-up"], "inout:user-management-step-up:v1.");
    assert.match(proof.windowId, /^[0-9a-f-]{36}$/);
    for await (const _chunk of req) { /* Drain synthetic bodies. */ }
    if (req.method === "POST") revokedWindows.add(proof.windowId);
    res.end(JSON.stringify(req.method === "POST" ? { locked: true } : { unlocked: !revokedWindows.has(proof.windowId) }));
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
    const maxAge = cookie.match(/;\s*Max-Age=(-?\d+)(?:;|$)/i);
    const expires = cookie.match(/;\s*Expires=([^;]+)/i);
    const deleted = maxAge ? Number(maxAge[1]) <= 0 : Boolean(expires && Date.parse(expires[1]) <= Date.now());
    if (deleted) jar.delete(name);
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
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", Origin: appUrl },
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

async function submitCredentials(jar, credentials = {}, callbackUrl = "/admin") {
  const csrf = await request("/api/auth/csrf", jarHeader(jar));
  assert.equal(csrf.status, 200);
  applyResponseCookies(jar, csrf);
  const { csrfToken } = await csrf.json();
  const signin = await request("/api/auth/callback/credentials", jarHeader(jar), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", Origin: appUrl },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${appUrl}${callbackUrl}`,
      username: "synthetic-admin", password: "correct-password", ...credentials }).toString(),
  });
  assert.equal(signin.status, 200);
  assert.equal(signin.headers.get("cache-control"), "no-store, max-age=0");
  applyResponseCookies(jar, signin);
  const data = await signin.clone().json();
  assert.equal(Object.keys(data).length, 1, "Only the redirect destination may enter the browser sign-in response");
  assert.equal(JSON.stringify(data).includes("SYNTHETIC_PRIVATE_PROVIDER_DETAIL"), false, "Provider diagnostics must stay private");
  return { response: signin, destination: new URL(data.url, appUrl) };
}

function decodeJarSession(jar) {
  const direct = jar.get(cookieName);
  const chunks = [...jar].filter(([name]) => name.startsWith(`${cookieName}.`))
    .sort(([left], [right]) => Number(left.slice(cookieName.length + 1)) - Number(right.slice(cookieName.length + 1)));
  return decode({ token: direct ?? chunks.map(([, value]) => value).join(""), secret, salt: cookieName });
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
    step_up_window_id: randomUUID(),
    step_up_expires_at: authTime + durationMinutes * 60, ...overrides });
}

function assertForwardedProof(captured, durationMinutes, authTime, before, after, bearer = accessToken("admin"), expiresAt = authTime + durationMinutes * 60) {
  assert.ok(captured.authorization === `Bearer ${bearer}`, "Identity calls must forward the signed session's bearer");
  const proof = signedPayload(captured.proof, "inout:user-management-step-up:v1.");
  assert.deepEqual(Object.keys(proof).sort(), ["authTime", "durationMinutes", "expiresAt", "issuedAt", "tokenHash", "windowId"]);
  assert.match(proof.windowId, /^[0-9a-f-]{36}$/);
  assert.equal(proof.durationMinutes, durationMinutes);
  assert.equal(proof.authTime, authTime);
  assert.equal(proof.expiresAt, expiresAt);
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

async function assertManagementLocked(cookie) {
  const page = await request("/admin/users", cookie);
  assert.equal(page.status, 307);
  const target = new URL(page.headers.get("location"), appUrl);
  assert.equal(target.pathname, "/login");
  assert.equal(target.searchParams.get("from"), "/admin/users");
  assert.equal(target.searchParams.get("stepUp"), "1");
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
  const providers = await (await request("/api/auth/providers")).json();
  assert.deepEqual(Object.keys(providers).sort(), ["credentials", "keycloak"], "The app form and optional account setup are the configured sign-in paths");
  const loginHtml = await (await request("/login")).text();
  assert.ok(/name="username"/.test(loginHtml) && /name="password"/.test(loginHtml), "The app must render its own username and password form");
  assert.match(loginHtml, /<form(?=[^>]*method="post")(?=[^>]*action="\/api\/auth\/callback\/credentials")[^>]*>/i,
    "Native submission before hydration must never put passwords or one-time codes in a GET URL");
  assert.ok(/autocomplete="username"/i.test(loginHtml) && /autocomplete="current-password"/i.test(loginHtml), "Password managers must recognize the sign-in fields");
  for (const from of ["//untrusted.invalid", "/%5cuntrusted.invalid", "/%255cuntrusted.invalid"]) {
    const login = await request(`/login?from=${encodeURIComponent(from)}`);
    assert.equal(login.status, 200);
    assert.equal((await login.text()).includes('"redirectTo":"//untrusted.invalid"'), false);
  }
  const expiredStepUp = await request("/login?from=%2Fadmin%2Fusers&stepUp=1");
  assert.equal(expiredStepUp.status, 200);
  assert.equal((await expiredStepUp.text()).includes("Unlock duration"), false, "An expired account must sign in before preparing an admin-only intent");
  const unknownPasswordProvider = await request("/api/auth/callback/keycloak-credentials", undefined, {
    method: "POST", headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=synthetic&password=synthetic",
  });
  assert.equal(unknownPasswordProvider.headers.getSetCookie().some((cookie) => cookie.startsWith(cookieName + "=")), false);
  for (const [options, status] of [
    [{ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "csrfToken=synthetic" }, 403],
    [{ headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/x-www-form-urlencoded" }, body: "csrfToken=synthetic" }, 403],
    [{ headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "csrfToken=one&csrfToken=two" }, 400],
    [{ headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "csrfToken=x&callbackUrl=%2F%5Cuntrusted.invalid" }, 400],
    [{ headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "x=" + "y".repeat(8192) }, 413],
  ]) {
    const denied = await request("/api/auth/signin/keycloak", undefined, { method: "POST", ...options });
    assert.equal(denied.status, status);
    assert.equal(denied.headers.get("cache-control"), "no-store, max-age=0");
  }
  {
    const authorizationJar = new Map();
    const csrf = await request("/api/auth/csrf");
    applyResponseCookies(authorizationJar, csrf);
    const { csrfToken } = await csrf.json();
    for (const query of ["redirect_uri=https%3A%2F%2Funtrusted.invalid", "client_id=untrusted-client", "response_type=token",
      "scope=openid%20offline_access", "response_mode=form_post", "prompt=none", "max_age=3600", "state=untrusted"]) {
      const denied = await request(`/api/auth/signin/keycloak?${query}`, jarHeader(authorizationJar), {
        method: "POST", headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ csrfToken, callbackUrl: "/admin/users" }).toString(),
      });
      assert.equal(denied.status, 400, "Browser parameters cannot override the configured OIDC authorization contract");
      assert.equal(denied.headers.getSetCookie().length, 0, "Rejected authorization overrides cannot issue OAuth cookies");
    }
  }
  assert.equal((await request("/api/profile")).status, 401);
  assert.equal(new URL((await request("/account")).headers.get("location"), appUrl).pathname, "/login");
  assert.equal(new URL((await request("/terminal")).headers.get("location"), appUrl).pathname, "/login");

  for (const credentials of [
    { password: "wrong-password" }, { username: "synthetic-otp" },
    { username: "synthetic-otp", otp: "000000" }, { username: "bad-token" },
    { username: "mixed-subject" }, { username: "setup-required" }, { username: "outage" },
  ]) {
    const failedJar = new Map();
    const failed = await submitCredentials(failedJar, credentials);
    assert.ok(failed.destination.searchParams.has("error"), "A failed password/token validation must not create a successful login");
    assert.equal([...failedJar.keys()].some((name) => name === cookieName || name.startsWith(`${cookieName}.`)), false,
      "Invalid credentials, OTP, provider tokens, and incomplete accounts must never issue an app session");
    assert.equal((await request("/api/profile", jarHeader(failedJar))).status, 401);
  }
  const ownFormJar = new Map();
  const passwordLogin = await submitCredentials(ownFormJar);
  assert.equal(passwordLogin.destination.href, `${appUrl}/admin`);
  assert.equal(ownFormJar.has(browserSsoCookieName), false, "A direct password login must not claim a browser SSO session");
  const ownFormSession = await decodeJarSession(ownFormJar);
  assert.equal(ownFormSession.provider, "credentials");
  assert.equal(ownFormSession.sub, "test-user");
  assert.equal(ownFormSession.auth_time, callbackAuthTime, "Fresh app sign-in must retain the provider's signed authentication time");
  assert.equal((await request("/api/profile", jarHeader(ownFormJar))).status, 200);
  const ownFormPublic = await (await request("/api/auth/session", jarHeader(ownFormJar))).json();
  assert.deepEqual(ownFormPublic.roles, ["admin"]);
  for (const name of ["access_token", "refresh_token", "id_token", "password", "otp"]) {
    assert.equal(JSON.stringify(ownFormPublic).includes(`"${name}"`), false, "Own-form public sessions must never expose credentials or provider tokens");
  }
  const otpJar = new Map();
  assert.equal((await submitCredentials(otpJar, { username: "synthetic-otp", otp: "123456" })).destination.pathname, "/admin");
  assert.equal(passwordGrants.at(-1).totp, "123456", "The optional one-time code must reach the provider's TOTP field");
  const grantsBeforeBoundaryDenials = passwordGrants.length;
  for (const [path, headers, body, status] of [
    ["/api/auth/callback/credentials", { Origin: "https://untrusted.invalid" }, "username=synthetic-admin&password=correct-password", 403],
    ["/api/auth/callback/credentials", { Origin: appUrl }, "username=one&username=two&password=correct-password", 400],
    ["/api/auth/callback/credentials?otp=123456", { Origin: appUrl }, "username=synthetic-otp&password=correct-password&otp=654321", 400],
  ]) {
    const blocked = await request(path, undefined, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body });
    assert.equal(blocked.status, status);
  }
  const missingCsrf = await request("/api/auth/callback/credentials", undefined, { method: "POST",
    headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: "username=synthetic-admin&password=correct-password&callbackUrl=%2Fadmin" });
  assert.equal(missingCsrf.headers.getSetCookie().some((value) => value.startsWith(cookieName + "=")), false);
  assert.equal(passwordGrants.length, grantsBeforeBoundaryDenials, "Rejected Origin, duplicate fields, and missing CSRF must not reach Keycloak");

  const response = await request("/api/profile", await sessionCookie());
  assert.equal(response.status, 200);
  assert.equal(refreshCalls, 1, "API wrapper and upstream helper must share a single refresh");
  assert.equal(upstreamTokens.at(-1), `Bearer ${accessToken("admin")}`);
  const cookie = updatedCookie(response);
  const decoded = await decode({ token: cookie.slice(cookie.indexOf("=") + 1), secret, salt: cookieName });
  assert.ok(decoded.expires_at > Date.now() / 1000);
  assert.ok(decoded.expires_at <= JSON.parse(Buffer.from(decoded.access_token.split(".")[1], "base64url").toString()).exp,
    "Refresh expiry cannot outlive the verified bearer expiry");
  const oldPasswordSession = await sessionCookie({ provider: "keycloak-credentials", expires_at: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await request("/api/profile", oldPasswordSession)).status, 401, "Removed password-grant sessions must reauthenticate");

  const publicSession = await (await request("/api/auth/session", cookie)).json();
  assert.deepEqual(publicSession.roles, ["admin"]);
  for (const name of ["access_token", "refresh_token", "id_token"]) {
    assert.equal(JSON.stringify(publicSession).includes(name), false, `Public session leaked ${name}`);
  }
  assert.equal((await request("/api/profile", cookie)).status, 200);
  assert.equal(refreshCalls, 1, "Persisted refreshed cookie should not need another refresh");
  const correlationId = randomUUID();
  const correlatedProfile = await request("/api/profile", cookie, { headers: { "X-Request-ID": correlationId } });
  assert.equal(correlatedProfile.headers.get("x-request-id"), correlationId);
  assert.deepEqual(upstreamRequestIds.at(-1), { path: "/v1/admin/profile", id: correlationId },
    "An authenticated BFF read must forward the gateway correlation ID to its upstream");
  const replacedCorrelation = await request("/api/profile", cookie, { headers: { "X-Request-ID": "invalid-caller-id" } });
  assert.match(replacedCorrelation.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(upstreamRequestIds.at(-1).id, replacedCorrelation.headers.get("x-request-id"));
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

  for (const method of ["GET", "POST", "DELETE"]) {
    const authTime = Math.floor(Date.now() / 1000) - 30;
    const original = await activeStepUpCookie(60, authTime, { expires_at: 1, refresh_token: `rotation-origin-${method}` });
    const refreshBefore = refreshCalls;
    const refreshed = await request("/api/auth/step-up", original, method === "GET" ? {} : {
      method, headers: { Origin: appUrl, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ durationMinutes: 10 }) } : {}),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshCalls, refreshBefore + 1);
    const renewedCookie = updatedCookie(refreshed);
    const renewed = await decode({ token: renewedCookie.slice(cookieName.length + 1), secret, salt: cookieName });
    assert.equal(renewed.refresh_token, `rotation-next-${method}`, "Every step-up response must persist the rotated refresh token");
    assert.equal(renewed.step_up_expires_at, authTime + 3600, "Token refresh must preserve the selected step-up deadline");
    assert.equal((await request("/api/profile", renewedCookie)).status, 200);
    assert.equal(refreshCalls, refreshBefore + 1, "The next request must reuse the refreshed cookie instead of a consumed token");
  }

  const logoutCookie = await sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600 });
  const forgedOrigin = "http://untrusted.invalid";
  const forgedLogoutJar = new Map([[cookieName, logoutCookie.slice(cookieName.length + 1)],
    [lockCookieName, "1"], [intentCookieName, "synthetic-intent"]]);
  const availabilityBeforeForgedLogout = availabilityUpdates.length;
  const revocationsBeforeForgedLogout = revocationRequests.length;
  const forgedLogout = await request("/logout", jarHeader(forgedLogoutJar), { method: "POST", headers: {
    Origin: forgedOrigin, Host: "untrusted.invalid", "X-Forwarded-Host": "untrusted.invalid", "X-Forwarded-Proto": "http",
    "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=30" });
  assert.equal(forgedLogout.status, 403, "A forged proxy Host cannot add another allowed logout origin");
  // Auth.js middleware renews ordinary session cookies before the route runs.
  // Assert preserved identity and no logout effects instead of no Set-Cookie.
  applyResponseCookies(forgedLogoutJar, forgedLogout);
  const sessionAfterForgedLogout = await decodeJarSession(forgedLogoutJar);
  assert.equal(sessionAfterForgedLogout?.sub, "test-user", "Rejected logout requests cannot clear the current session");
  assert.equal(Boolean(sessionAfterForgedLogout?.access_token), true);
  assert.equal(forgedLogoutJar.get(lockCookieName), "1");
  assert.equal(forgedLogoutJar.get(intentCookieName), "synthetic-intent");
  assert.equal(availabilityUpdates.length, availabilityBeforeForgedLogout);
  assert.equal(revocationRequests.length, revocationsBeforeForgedLogout);
  const forcedLogout = await request("/logout/complete", logoutCookie, { headers: {
    Origin: "https://untrusted.example.invalid", "Sec-Fetch-Site": "cross-site" } });
  assert.equal(forcedLogout.status, 403);
  assert.equal(forcedLogout.headers.getSetCookie().length, 0, "Unsolicited logout callbacks must not alter any session cookies");
  const logoutJar = new Map([[cookieName, logoutCookie.slice(cookieName.length + 1)], [lockCookieName, "1"], [intentCookieName, "synthetic-intent"]]);
  stallAvailability = true;
  const logoutStarted = Date.now();
  const logout = await request("/logout", jarHeader(logoutJar), { method: "POST", headers: {
    Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=45" });
  stallAvailability = false;
  assert.equal(logout.status, 303);
  assert.ok(Date.now() - logoutStarted < 8_000, "An unavailable availability API must not indefinitely block logout");
  const providerLogout = new URL(logout.headers.get("location"));
  assert.equal(providerLogout.origin, upstreamUrl);
  assert.equal(providerLogout.pathname, "/realms/inout/protocol/openid-connect/logout");
  assert.equal(providerLogout.searchParams.get("post_logout_redirect_uri"), `${appUrl}/logout/complete`);
  applyResponseCookies(logoutJar, logout);
  assert.equal(logoutJar.has(cookieName), false, "Local session must be cleared before visiting the provider");
  assert.equal(logoutJar.has(lockCookieName), false);
  assert.equal(logoutJar.has(intentCookieName), false);
  assert.equal((await request("/api/profile", jarHeader(logoutJar))).status, 401);
  const availabilityBeforeCallback = availabilityUpdates.length;
  const providerReturn = await fetch(providerLogout, { redirect: "manual" });
  assert.equal(logoutRequests.length, 1);
  const providerReturnUrl = new URL(providerReturn.headers.get("location"));
  const logoutComplete = await request(providerReturnUrl.pathname + providerReturnUrl.search, jarHeader(logoutJar));
  assert.equal(logoutComplete.status, 303);
  assert.equal(new URL(logoutComplete.headers.get("location")).pathname, "/login");
  assert.equal(availabilityUpdates.length, availabilityBeforeCallback, "Logout callback must not repeat an unbounded availability call");
  assert.ok(!logoutComplete.headers.getSetCookie().some((cookie) => cookie.startsWith(cookieName + "=")), "A delayed logout callback must never erase a newly signed-in session");
  assert.ok(!logoutComplete.headers.getSetCookie().some((cookie) => cookie.startsWith(intentCookieName + "=") || cookie.startsWith(lockCookieName + "=")),
    "A delayed logout return must not clear another tab's newer re-authentication intent or lock");
  applyResponseCookies(logoutJar, logoutComplete);
  assert.equal((await request(providerReturnUrl.pathname + providerReturnUrl.search, jarHeader(logoutJar))).status, 403, "A completed logout intent is consumed");
  limitedApiRoute = "/v1/user-management/lock";
  const failedLockCookie = await activeStepUpCookie(60);
  const failedLockLogout = await request("/logout", failedLockCookie, { method: "POST", headers: {
    Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=30" });
  assert.equal(failedLockLogout.status, 303, "API failure must not keep the browser signed in");
  assert.ok(failedLockLogout.headers.getSetCookie().some((value) => value.startsWith(`${cookieName}=;`)));
  limitedApiRoute = undefined;
  const expiredLogout = await request("/logout", await sessionCookie({ refresh_token: "revoked" }), { method: "POST", headers: {
    Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=30" });
  assert.equal(new URL(expiredLogout.headers.get("location")).pathname, "/realms/inout/protocol/openid-connect/logout",
    "A failed bearer refresh must still end browser SSO");

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
  await assertManagementLocked(freshAdmin);
  await assertIdentityBlocked(freshAdmin);
  await assertIdentityBlocked(undefined, 401);
  await assertIdentityBlocked(operator, 403, {}, null);

  // Own-form reauthentication must complete the exact signed intent, including
  // all six durations and an extension of the captured existing window.
  {
    const switchedJar = new Map(ownFormJar);
    const started = await stepUpRequest(jarHeader(switchedJar), { durationMinutes: 15 });
    applyResponseCookies(switchedJar, started);
    assert.equal((await submitCredentials(switchedJar, { username: "different-admin" }, "/admin/users")).destination.pathname, "/admin/users");
    assert.ok(switchedJar.has(intentCookieName) && switchedJar.has(lockCookieName), "A different account must not consume another administrator's own-form intent");
    assert.equal((await decodeJarSession(switchedJar)).sub, "different-admin");
    await assertIdentityBlocked(jarHeader(switchedJar));
  }
  let completedCredentialJar;
  for (const durationMinutes of stepUpDurations) {
    const credentialJar = new Map(ownFormJar);
    const started = await stepUpRequest(jarHeader(credentialJar), { durationMinutes });
    assert.equal(started.status, 200);
    const intent = signedPayload(responseCookie(started, intentCookieName).split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v2.");
    applyResponseCookies(credentialJar, started);
    const login = await request(`/login?stepUp=1&from=%2Fadmin%2Fusers&durationMinutes=${durationMinutes}`, jarHeader(credentialJar));
    assertDurationSelect(await login.text(), durationMinutes, "Unlock duration");
    if (durationMinutes === 5) {
      const failedJar = new Map(credentialJar);
      const failed = await submitCredentials(failedJar, { password: "wrong-password" }, "/admin/users");
      assert.ok(failed.destination.searchParams.has("error"));
      assert.ok(failedJar.has(intentCookieName) && failedJar.has(lockCookieName), "A failed password callback must retain the reauthentication intent and lock");
      await assertIdentityBlocked(jarHeader(failedJar));
    }
    const completed = await submitCredentials(credentialJar, {}, "/admin/users");
    assert.equal(completed.destination.href, `${appUrl}/admin/users`);
    assert.equal(credentialJar.has(intentCookieName), false, "Only a completed fresh own-form callback may clear its intent");
    assert.equal(credentialJar.has(lockCookieName), false, "Verified credentials must unlock the exact newly issued app session");
    const session = await decodeJarSession(credentialJar);
    assert.equal(session.provider, "credentials");
    assert.equal(session.step_up_intent_id, intent.intentId);
    assert.equal(session.step_up_duration_minutes, durationMinutes);
    assert.equal(session.step_up_expires_at, callbackAuthTime + durationMinutes * 60);
    const before = Date.now();
    assert.equal((await request("/api/keycloak", jarHeader(credentialJar))).status, 200);
    assertForwardedProof(identityRequests.at(-1), durationMinutes, callbackAuthTime, before, Date.now(), callbackAccessToken);
    if (durationMinutes === 5) completedCredentialJar = credentialJar;
  }
  {
    const prior = await decodeJarSession(completedCredentialJar);
    const started = await stepUpRequest(jarHeader(completedCredentialJar), { durationMinutes: 30 });
    assert.equal(started.status, 200);
    const intent = signedPayload(responseCookie(started, intentCookieName).split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v2.");
    assert.equal(intent.baseExpiresAt, prior.step_up_expires_at, "Extension must preserve the original server-captured expiry");
    applyResponseCookies(completedCredentialJar, started);
    await assertIdentityBlocked(jarHeader(completedCredentialJar));
    const failed = await submitCredentials(completedCredentialJar, { password: "wrong-password" }, "/admin/users");
    assert.ok(failed.destination.searchParams.has("error"));
    assert.ok(completedCredentialJar.has(intentCookieName) && completedCredentialJar.has(lockCookieName));
    await assertIdentityBlocked(jarHeader(completedCredentialJar));
    const retried = await stepUpRequest(jarHeader(completedCredentialJar), { durationMinutes: 20 });
    assert.equal(retried.status, 200);
    const retriedIntent = signedPayload(responseCookie(retried, intentCookieName).split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v2.");
    assert.equal(retriedIntent.baseExpiresAt, prior.step_up_expires_at,
      "Repreparing after a failed extension must preserve the original expiry even though its old window is now locked");
    assert.equal(retriedIntent.durationMinutes, 20, "A retry may change the selected duration without losing its original base");
    assert.notEqual(retriedIntent.intentId, intent.intentId);
    applyResponseCookies(completedCredentialJar, retried);
    const completed = await submitCredentials(completedCredentialJar, {}, "/admin/users");
    assert.equal(completed.destination.pathname, "/admin/users");
    const extended = await decodeJarSession(completedCredentialJar);
    assert.equal(extended.step_up_expires_at, prior.step_up_expires_at + 20 * 60);
    assert.equal(extended.step_up_duration_minutes, 20);
    assert.equal(extended.step_up_intent_id, retriedIntent.intentId);
    assert.notEqual(extended.step_up_window_id, prior.step_up_window_id, "Extension must issue a fresh window rather than revive the revoked one");
    assert.equal(completedCredentialJar.has(intentCookieName), false);
    assert.equal(completedCredentialJar.has(lockCookieName), false);
    assert.equal((await request("/api/keycloak", jarHeader(completedCredentialJar))).status, 200);
  }

  assert.equal((await stepUpRequest(undefined, { durationMinutes: 5 })).status, 401);
  assert.equal((await stepUpRequest(operator, { durationMinutes: 5 })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: "https://untrusted.example.invalid" })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: "null" })).status, 403);
  assert.equal((await stepUpRequest(freshAdmin, { durationMinutes: 5 }, { Origin: `${appUrl}/path` })).status, 403);
  for (const method of ["POST", "DELETE"]) {
    const forgedStepUp = await request("/api/auth/step-up", freshAdmin, { method, headers: {
      Origin: "http://untrusted.invalid", Host: "untrusted.invalid", "X-Forwarded-Host": "untrusted.invalid", "X-Forwarded-Proto": "http",
      "Content-Type": "application/json" }, ...(method === "POST" ? { body: '{"durationMinutes":5}' } : {}) });
    assert.equal(forgedStepUp.status, 403, "A forged proxy Host cannot add another allowed re-authentication origin");
    assert.equal(forgedStepUp.headers.getSetCookie().some((cookie) => cookie.startsWith(`${intentCookieName}=`) || cookie.startsWith(`${lockCookieName}=`)), false);
  }
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
    const intent = signedPayload(intentCookie.split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v2.");
    assert.deepEqual(Object.keys(intent).sort(), ["durationMinutes", "intentId", "issuedAt", "subject"]);
    assert.equal(intent.subject, "test-user");
    assert.match(intent.intentId, /^[0-9a-f-]{36}$/);
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
    assert.ok(managementHtml.includes('aria-label="Re-authentication expires in '));
    const extendButton = managementHtml.match(/<button\b([^>]*aria-label="Extend access"[^>]*)>/);
    assert.ok(extendButton && /\btype="button"/.test(extendButton[1]) && !/\bdisabled(?:=|\s|$)/.test(extendButton[1]), "The extension controls must include an enabled Extend button");
    assert.ok(managementHtml.includes('aria-label="Lock user management"'));
    assertDurationSelect(managementHtml, durationMinutes, "Duration");
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
  await assertManagementLocked(lockedSession);
  // Removing the cosmetic lock cookie or replaying the pre-lock encrypted
  // session cannot resurrect the persisted, revoked window.
  await assertIdentityBlocked(longSession);
  await assertManagementLocked(longSession);
  const renew = await stepUpRequest(lockedSession, { durationMinutes: 10 });
  assert.equal(renew.status, 200);
  const pendingLock = responseCookie(renew, lockCookieName);
  assert.ok(Number(pendingLock.match(/\bMax-Age=(\d+)/i)?.[1]) >= 3600);
  const pendingSession = `${longSession}; ${pendingLock.split(";")[0]}; ${responseCookie(renew, intentCookieName).split(";")[0]}`;
  await assertIdentityBlocked(pendingSession);
  await assertManagementLocked(pendingSession);
  const unchangedSession = await (await request("/api/auth/session", pendingSession)).json();
  assert.equal(unchangedSession.stepUpExpiresAt, longAuthTime + 3600, "Starting a new sign-in must not silently extend the old expiry");
  assert.equal(unchangedSession.stepUpDurationMinutes, 60);

  const largeJar = chunkedSessionJar(await sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600,
    access_token: await largeAdminAccessToken(), refresh_token: largeRefreshToken }));
  assertLargeCookieHeader(largeJar);
  assert.equal((await request("/api/profile", jarHeader(largeJar))).status, 200,
    "Protected admin API requests must accept a large, valid chunked session");
  await assertManagementLocked(jarHeader(largeJar));
  await assertIdentityBlocked(jarHeader(largeJar));
  const largeOperator = chunkedSessionJar(await sessionCookie({ roles: ["operator"],
    access_token: accessToken("operator"), refresh_token: randomBytes(13_000).toString("base64url"),
    expires_at: Math.floor(Date.now() / 1000) + 600 }));
  assertLargeCookieHeader(largeOperator);
  assert.equal((await stepUpRequest(jarHeader(largeOperator), { durationMinutes: 15 })).status, 403,
    "Large cookies must preserve the administrator-only unlock check");
  await assertIdentityBlocked(jarHeader(largeOperator), 403, {}, null);

  {
    const mismatchedJar = new Map(largeJar);
    const start = await stepUpRequest(jarHeader(mismatchedJar), { durationMinutes: 15 });
    assert.equal(start.status, 200);
    applyResponseCookies(mismatchedJar, start);
    const pendingIntent = mismatchedJar.get(intentCookieName);
    const pendingLock = mismatchedJar.get(lockCookieName);
    assert.equal(signedPayload(pendingIntent, "inout:user-management-intent:v2.").subject, "test-user");
    let callbackUrl;
    callbackSessionMismatch = true;
    try { callbackUrl = await startSyntheticLogin(mismatchedJar); }
    finally { callbackSessionMismatch = false; }
    const exchangesBefore = codeExchanges;
    const rejected = await request(callbackUrl.pathname + callbackUrl.search, jarHeader(mismatchedJar));
    assert.equal(rejected.status, 302);
    assert.equal(codeExchanges, exchangesBefore + 1, "The session-binding rejection must occur after a real code/PKCE exchange");
    assert.equal(rejected.headers.getSetCookie().some((cookie) => cookie.startsWith(`${browserSsoCookieName}=`)), false,
      "Validly signed same-account tokens from different sessions must not record successful browser SSO");
    applyResponseCookies(mismatchedJar, rejected);
    assert.equal(await decodeJarSession(mismatchedJar), null, "An OIDC token-pair mismatch must not issue a valid app session");
    assert.equal(mismatchedJar.has(browserSsoCookieName), false);
    assert.equal(mismatchedJar.get(intentCookieName), pendingIntent, "Failed token-pair verification must preserve the signed pending intent");
    assert.equal(mismatchedJar.get(lockCookieName), pendingLock, "Failed token-pair verification must preserve the user-management lock");
    assert.equal((await request("/api/profile", jarHeader(mismatchedJar))).status, 401);
    await assertIdentityBlocked(jarHeader(mismatchedJar), 401);
  }

  let completedChunkCount;
  {
    const differentAccountJar = new Map(largeJar);
    const start = await stepUpRequest(jarHeader(differentAccountJar), { durationMinutes: 60 });
    assert.equal(start.status, 200);
    applyResponseCookies(differentAccountJar, start);
    callbackSubject = "different-admin";
    const switched = await startSyntheticLogin(differentAccountJar);
    const completed = await request(switched.pathname + switched.search, jarHeader(differentAccountJar));
    callbackSubject = "test-user";
    applyResponseCookies(differentAccountJar, completed);
    assert.ok(differentAccountJar.has(intentCookieName) && differentAccountJar.has(lockCookieName), "Switching account cannot consume another admin's intent");
    const otherSession = await (await request("/api/auth/session", jarHeader(differentAccountJar))).json();
    assert.equal(otherSession.subject, "different-admin");
    assert.equal(otherSession.stepUpExpiresAt, undefined);
    await assertIdentityBlocked(jarHeader(differentAccountJar));
  }
  for (const durationMinutes of [15, 30]) {
    assertLargeCookieHeader(largeJar);
    const start = await stepUpRequest(jarHeader(largeJar), { durationMinutes });
    assert.equal(start.status, 200, "A realistic large Cookie header must reach the step-up handler without HTTP 431");
    const startedIntent = signedPayload(responseCookie(start, intentCookieName).split(";")[0].slice(intentCookieName.length + 1), "inout:user-management-intent:v2.");
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
    assert.equal(invalidCallback.headers.getSetCookie().some((cookie) => cookie.startsWith(`${browserSsoCookieName}=`)), false,
      "Failed OAuth callbacks must not record successful browser SSO");
    applyResponseCookies(invalidJar, invalidCallback);
    assert.ok(invalidJar.has(lockCookieName) && invalidJar.has(intentCookieName));
    await assertIdentityBlocked(jarHeader(invalidJar));

    assertLargeCookieHeader(largeJar);
    const completed = await request(callbackUrl.pathname + callbackUrl.search, jarHeader(largeJar));
    assert.equal(completed.status, 302);
    assert.equal(completed.headers.get("location"), `${appUrl}/admin/users`, "Fresh OIDC callback must return to Manage users");
    assert.equal(codeExchanges, exchangesBeforeCallback + 1);
    const ssoCookie = responseCookie(completed, browserSsoCookieName);
    assert.ok(/;\s*HttpOnly\b/i.test(ssoCookie) && /;\s*SameSite=Lax\b/i.test(ssoCookie));
    assert.equal(Number(ssoCookie.match(/\bMax-Age=(\d+)/i)?.[1]), 30 * 24 * 60 * 60);
    applyResponseCookies(largeJar, completed);
    assert.equal(largeJar.get(browserSsoCookieName), "1", "An actually issued OAuth session must record its browser logout obligation");
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
    const completedExpiry = (startedIntent.baseExpiresAt ?? callbackAuthTime) + durationMinutes * 60;
    assert.equal(completedSession.stepUpExpiresAt, completedExpiry, "Fresh extension must add the chosen duration to the captured existing window");
    for (const name of ["access_token", "refresh_token", "id_token"]) {
      assert.equal(JSON.stringify(completedSession).includes(name), false, "Large public sessions must still hide all provider tokens");
    }
    const beforeCall = Date.now();
    const unlockedUsers = await request("/api/keycloak", jarHeader(largeJar));
    assert.equal(unlockedUsers.status, 200, "The callback's verified fresh authentication must unlock the identity API");
    assertForwardedProof(identityRequests.at(-1), durationMinutes, callbackAuthTime, beforeCall, Date.now(), callbackAccessToken, completedExpiry);
    const unlockedPage = await request("/admin/users", jarHeader(largeJar));
    assert.equal(unlockedPage.status, 200);
    assert.ok((await unlockedPage.text()).includes('aria-label="Re-authentication expires in '));
  }
  {
    const mixedJar = new Map(largeJar);
    const started = await stepUpRequest(jarHeader(mixedJar), { durationMinutes: 10 });
    assert.equal(started.status, 200);
    applyResponseCookies(mixedJar, started);
    assert.equal((await submitCredentials(mixedJar, {}, "/admin/users")).destination.pathname, "/admin/users");
    assert.equal((await decodeJarSession(mixedJar)).provider, "credentials");
    assert.equal(mixedJar.get(browserSsoCookieName), "1", "Password reauthentication must preserve an earlier browser SSO logout obligation");
    assert.equal((await request("/api/keycloak", jarHeader(mixedJar))).status, 200);
    const revocationsBefore = revocationRequests.length;
    const mixedLogout = await request("/logout", jarHeader(mixedJar), { method: "POST", headers: {
      Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=30" });
    assert.equal(mixedLogout.status, 303);
    assert.equal(revocationRequests.length, revocationsBefore + 1, "Mixed-flow logout must revoke its current password-grant refresh token");
    const providerDestination = new URL(mixedLogout.headers.get("location"));
    assert.equal(providerDestination.origin, upstreamUrl);
    assert.equal(providerDestination.pathname, "/realms/inout/protocol/openid-connect/logout",
      "Earlier browser SSO must also be ended after switching the app session to credentials");
    applyResponseCookies(mixedJar, mixedLogout);
    for (const name of [browserSsoCookieName, intentCookieName, lockCookieName]) assert.equal(mixedJar.has(name), false);
    assert.equal([...mixedJar.keys()].some((name) => name === cookieName || name.startsWith(`${cookieName}.`)), false);
    const providerReturn = await fetch(providerDestination, { redirect: "manual" });
    const callback = new URL(providerReturn.headers.get("location"));
    const completed = await request(callback.pathname + callback.search, jarHeader(mixedJar));
    assert.equal(completed.status, 303);
    assert.equal(new URL(completed.headers.get("location"), appUrl).pathname, "/login");
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
  const resumed = await request("/api/presence?since=7", await sessionCookie(), {
    headers: { "Last-Event-ID": "9", "X-Request-ID": correlationId },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get("x-request-id"), correlationId);
  assert.deepEqual(upstreamRequestIds.at(-1), { path: "/v1/presence/stream", id: correlationId });
  const resumedReader = resumed.body.getReader();
  await resumedReader.read();
  await resumedReader.cancel();
  assert.deepEqual(presenceRequests.at(-1), { search: "?since=7", lastId: "9" });
  const streamRequestsBeforeInvalid = presenceRequests.length;
  const invalidCursor = await request("/api/presence?since=-1", await sessionCookie());
  assert.equal(invalidCursor.status, 422);
  assert.equal(presenceRequests.length, streamRequestsBeforeInvalid);
  const limitCookie = await sessionCookie({ expires_at: Math.floor(Date.now() / 1000) + 600 });
  for (const [upstreamPath, browserPath] of [
    ["/v1/terminal/bundle", "/api/data?scope=terminal"],
    ["/v1/presence/stream", "/api/presence"],
    ["/v1/admin/profile", "/api/profile"],
  ]) {
    limitedApiRoute = upstreamPath;
    limitedApiResponseKey = upstreamPath === "/v1/presence/stream" ? "detail" : "message";
    const rejected = await request(browserPath, limitCookie);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get("Retry-After"), "37", "BFF errors must preserve the server's retry window");
    assert.match((await rejected.json()).error, /37 seconds/);
  }
  limitedApiRoute = "/v1/terminal/scans";
  limitedApiResponseKey = "message";
  const throttledScan = await request("/api/data", limitCookie, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: appUrl },
    body: JSON.stringify({ action: "recordScan", input: { barcode: "test", checkpointId: "cp-main" } }),
  });
  assert.equal(throttledScan.status, 429);
  assert.equal(throttledScan.headers.get("Retry-After"), "37");
  assert.match((await throttledScan.json()).error, /37 seconds/);
  limitedApiRoute = "/v1/keycloak/users";
  const throttledIdentity = await request("/api/keycloak", await activeStepUpCookie(5));
  assert.equal(throttledIdentity.status, 429);
  assert.equal(throttledIdentity.headers.get("Retry-After"), "37");
  assert.match((await throttledIdentity.json()).error, /37 seconds/);
  limitedApiRoute = "/v1/user-management/window";
  const throttledWindow = await request("/api/auth/step-up", await activeStepUpCookie(5));
  assert.equal(throttledWindow.status, 429);
  assert.equal(throttledWindow.headers.get("Retry-After"), "37");
  assert.match((await throttledWindow.json()).error, /37 seconds/);
  limitedApiRoute = undefined;
  const failedScan = await fetch(`${appUrl}/api/data`, { method: "POST",
    headers: { cookie, "Content-Type": "application/json", Origin: appUrl },
    body: JSON.stringify({ action: "recordScan", input: { barcode: "test", checkpointId: "cp-main" } }),
  });
  assert.equal(failedScan.status, 502, "An upstream connection failure must remain retryable by the offline queue");
  const ownLogoutJar = new Map(ownFormJar);
  const revocationsBefore = revocationRequests.length;
  const ownLogout = await request("/logout", jarHeader(ownLogoutJar), { method: "POST", headers: {
    Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: "offlineDurationMinutes=30" });
  assert.equal(ownLogout.status, 303);
  assert.equal(new URL(ownLogout.headers.get("location"), appUrl).pathname, "/login", "Own-form logout must return directly to the app sign-in page");
  applyResponseCookies(ownLogoutJar, ownLogout);
  assert.equal(ownLogoutJar.has(browserSsoCookieName), false);
  assert.equal(revocationRequests.length, revocationsBefore + 1, "Own-form logout must revoke the provider refresh token server-side");
  assert.equal(revocationRequests.at(-1), ownFormSession.refresh_token);
  assert.equal((await request("/api/profile", jarHeader(ownLogoutJar))).status, 401);
  console.log("Keycloak HTTP checks passed: own sign-in form, credential/OTP failures and success, signed token/account binding, generic errors, direct refresh-token revocation, six own-form re-authentication windows and extension, session isolation/refresh, role routing, terminal assignments, signed intent/proof forwarding, strict expiry, Origin/CSRF/body denial, lock persistence, canceled renewal, cookie tampering, large chunked-cookie protected routes, two optional synthetic OIDC setup/unlock callbacks, rejected OAuth state and signed session mismatch, temporary-cookie cleanup, stable session chunks, the 64 KiB header bound, and data/write/stream Retry-After forwarding.");
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
