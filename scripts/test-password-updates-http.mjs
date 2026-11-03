// Run after npm run build. All identities, passwords, leases and upstreams are
// synthetic and process-local; this never contacts the configured real realm.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { encode, decode } from "next-auth/jwt";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const secret = randomBytes(32).toString("base64url");
const frontendSecret = "synthetic-password-http-frontend-secret";
const serviceSecret = "synthetic-password-http-service-secret";
const serviceToken = "synthetic-password-http-service-token";
const cookieName = "authjs.session-token";
const intentCookie = "inout_user_management_step_up";
const lockCookie = "inout_user_management_step_up_lock";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "password-http-fixture", alg: "RS256", use: "sig" };
const users = new Map();
const leases = new Map();
const resets = [];
const revocations = [];
const interactionCodes = new Map();
let serviceUnavailable = false;
let leaseUnavailable = false;
let pauseProof;
const loseResetResponses = new Set();

function addUser(id, { temporary = false, enabled = true, actions, otp = "", role = "master-admin" } = {}) {
  const user = { id, username: `fixture-${id}`, email: `fixture-${id}@example.invalid`, enabled,
    requiredActions: actions ?? (temporary ? ["UPDATE_PASSWORD"] : []), role, otp,
    password: `synthetic-current-${id}`, credentialId: randomUUID() };
  users.set(id, user);
  return user;
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, enabled: user.enabled,
    requiredActions: [...user.requiredActions] };
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function tokens(user) {
  const now = Math.floor(Date.now() / 1000);
  const sid = randomUUID();
  const accessToken = await new SignJWT({ typ: "Bearer", azp: "inout-frontend", auth_time: now, sid,
    realm_access: { roles: [user.role] } }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject(user.id).setIssuer(issuer).setAudience("inout-frontend").setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
  const identity = await new SignJWT({ typ: "ID", azp: "inout-frontend", auth_time: now, sid,
    name: "Synthetic account", email: user.email }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject(user.id).setIssuer(issuer).setAudience("inout-frontend").setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
  return { access_token: accessToken, id_token: identity, refresh_token: "synthetic-probe-" + randomUUID(),
    token_type: "Bearer", expires_in: 600 };
}

const upstream = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, upstreamUrl);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (url.pathname === "/internal/password-updates/lease") {
      const timestamp = request.headers["x-inout-password-lease-time"];
      const supplied = request.headers["x-inout-password-lease-signature"];
      const expected = createHmac("sha256", secret).update(`inout:password-update-lease:v1\n${timestamp}\n`).update(raw).digest();
      if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(expected, Buffer.from(supplied, "hex")) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 15) {
        return send(response, 401, { detail: "Synthetic lease proof rejected" });
      }
      if (leaseUnavailable) return send(response, 503, { detail: "Synthetic lease outage" });
      const body = JSON.parse(raw);
      if (body.action === "acquire") {
        if (leases.has(body.subject)) return send(response, 409, { detail: "Synthetic lease busy" });
        leases.set(body.subject, body.leaseId);
      } else if (leases.get(body.subject) === body.leaseId) leases.delete(body.subject);
      return send(response, 200, { ok: true });
    }
    if (url.pathname === "/realms/inout/protocol/openid-connect/certs") return send(response, 200, { keys: [jwk] });
    if (url.pathname === "/realms/inout/protocol/openid-connect/revoke") {
      const form = new URLSearchParams(raw.toString());
      assert.equal(form.get("client_secret"), frontendSecret);
      revocations.push(form.get("token"));
      return send(response, 200, {});
    }
    if (url.pathname.startsWith("/realms/inout/inout-auth/")) {
      assert.equal(request.headers.authorization, "Basic " + Buffer.from("inout-frontend:" + frontendSecret).toString("base64"));
      if (serviceUnavailable) return send(response, 503, { error: "service_unavailable" });
      const body = JSON.parse(raw);
      if (url.pathname.endsWith("/token")) {
        const grant = interactionCodes.get(body.code);
        interactionCodes.delete(body.code);
        if (!grant || createHash("sha256").update(body.codeVerifier).digest("base64url") !== grant.challenge) {
          return send(response, 401, { error: "credentials" });
        }
        return send(response, 200, await tokens(grant.user));
      }
      const user = [...users.values()].find((candidate) => candidate.username === body.username || candidate.email === body.username);
      if (!user?.enabled || (body.expectedSubject && body.expectedSubject !== user.id)) return send(response, 401, { error: "credentials" });
      if (url.pathname.endsWith("/prepare")) return send(response, 200, { subject: user.id });
      assert.ok(url.pathname.endsWith("/verify"));
      if (pauseProof?.subject === user?.id) {
        const pause = pauseProof;
        pause.entered();
        await pause.wait;
      }
      if (body.currentPassword !== user.password || (user.otp && body.otp !== user.otp)) {
        return send(response, 401, { error: "credentials" });
      }
      if (body.mode === "login") {
        if (user.requiredActions.length) return send(response, user.requiredActions.length === 1 && user.requiredActions[0] === "UPDATE_PASSWORD" ? 409 : 401,
          { error: user.requiredActions.length === 1 && user.requiredActions[0] === "UPDATE_PASSWORD" ? "account_setup_required" : "credentials" });
        const code = randomBytes(32).toString("base64url");
        interactionCodes.set(code, { user, challenge: body.codeChallenge });
        return send(response, 200, { code, expiresIn: 30, subject: user.id });
      }
      if ((body.mode === "setup" && (user.requiredActions.length !== 1 || user.requiredActions[0] !== "UPDATE_PASSWORD")) ||
          (body.mode === "change" && user.requiredActions.length)) {
        return send(response, 401, { error: "credentials" });
      }
      assert.equal(body.expectedSubject, user.id);
      resets.push(user.id);
      user.password = body.newPassword;
      user.requiredActions = user.requiredActions.filter((action) => action !== "UPDATE_PASSWORD");
      user.credentialId = randomUUID();
      if (loseResetResponses.has(user.id)) { request.socket.destroy(); return; }
      return send(response, 200, { ok: true, subject: user.id });
    }
    return send(response, 404, { detail: "Unexpected synthetic upstream route" });
  } catch {
    send(response, 500, { detail: "Synthetic upstream contract failed" });
  }
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const issuer = upstreamUrl + "/realms/inout";
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const appUrl = `http://localhost:${port}`;
const app = spawn(process.execPath, ["--max-http-header-size=65536", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, AUTH_URL: appUrl, AUTH_SECRET: secret, AUTH_TRUST_HOST: "true",
    KEYCLOAK_CLIENT_ID: "inout-frontend", KEYCLOAK_CLIENT_SECRET: frontendSecret,
    KEYCLOAK_ISSUER: issuer, KEYCLOAK_ISSUER_PUBLIC: issuer, KEYCLOAK_JWKS_BASE: issuer,
    KEYCLOAK_PASSWORD_UPDATE_CLIENT_ID: "inout-password-updates", KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET: serviceSecret,
    PASSWORD_UPDATE_LOCK_API_URL: upstreamUrl, PYTHON_API_URL: upstreamUrl, NEXT_TELEMETRY_DISABLED: "1" },
});
let diagnostics = "";
let startupError;
app.stdout.resume();
app.stderr.on("data", (value) => { diagnostics = (diagnostics + value).slice(-6000); });
app.on("error", (error) => { startupError = error; });

function request(path, jar = new Map(), options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(appUrl + path, { method: options.method || "GET", family: 4, maxHeaderSize: 65536,
      signal: AbortSignal.timeout(20_000), headers: {
        ...(jar.size ? { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...options.headers,
      } }, (response) => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function applyCookies(jar, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(";", 1)[0];
    const index = first.indexOf("=");
    const name = first.slice(0, index);
    if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, first.slice(index + 1));
  }
}

async function csrfJar(initial = new Map()) {
  const jar = new Map(initial);
  const response = await request("/api/auth/csrf", jar);
  assert.equal(response.status, 200);
  applyCookies(jar, response);
  const { csrfToken } = await response.json();
  return { jar, csrfToken };
}

function update(state, user, changes = {}, options = {}) {
  const body = { mode: "setup", username: user.username, currentPassword: user.password,
    newPassword: `synthetic-new-${user.id}`, confirmPassword: `synthetic-new-${user.id}`,
    otp: user.otp, csrfToken: state.csrfToken, ...changes };
  return request("/api/auth/password/update", state.jar, { method: "POST",
    headers: { Origin: appUrl, "Content-Type": "application/json", ...options.headers }, body: JSON.stringify(body) });
}

async function assertResponse(response, expected, secrets = []) {
  assert.equal(response.status, expected);
  assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
  const text = await response.clone().text();
  for (const value of [serviceToken, serviceSecret, frontendSecret, ...secrets]) assert.ok(!text.includes(value), "Public responses must exclude credentials and provider tokens");
  if (expected === 200) assert.deepEqual(await response.json(), { ok: true });
  else assert.equal(typeof (await response.json()).error, "string");
}

async function browserSession(user) {
  const pair = await tokens(user);
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, provider: "credentials", roles: [user.role], access_token: pair.access_token,
    refresh_token: "synthetic-browser-refresh", expires_at: now + 600, auth_time: now - 30,
    step_up_duration_minutes: 15, step_up_expires_at: now + 870, step_up_window_id: randomUUID() };
  const value = await encode({ token: payload, secret, salt: cookieName });
  return { jar: new Map([[cookieName, value], [lockCookie, "1"]]), payload };
}

function sessionValue(jar) {
  return jar.get(cookieName) || [...jar].filter(([key]) => key.startsWith(cookieName + "."))
    .sort(([left], [right]) => Number(left.slice(cookieName.length + 1)) - Number(right.slice(cookieName.length + 1)))
    .map(([, value]) => value).join("");
}

try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (app.exitCode !== null) throw new Error("Isolated password test server exited before readiness");
    try { if ((await request("/api/auth/session")).ok) { ready = true; break; } } catch { /* Wait for this task's owned app process. */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, "Isolated password-update app readiness timed out");
  const setup = addUser("temporary-master", { temporary: true, otp: "123456" });
  const setupState = await csrfJar();
  const originalPassword = setup.password;
  const completed = await update(setupState, setup);
  await assertResponse(completed, 200, [originalPassword, setup.password]);
  assert.ok(!completed.headers.getSetCookie().some((cookie) => /^(?:__Secure-)?authjs\.session-token/.test(cookie)), "Setup cannot issue a signed-in session");
  assert.deepEqual(setup.requiredActions, []);
  assert.equal((await (await request("/api/auth/session", setupState.jar)).json()), null);
  const signedIn = await request("/api/auth/callback/credentials", setupState.jar, { method: "POST",
    headers: { Origin: appUrl, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: new URLSearchParams({ username: setup.username, password: setup.password, otp: setup.otp,
      csrfToken: setupState.csrfToken, callbackUrl: appUrl + "/admin" }).toString() });
  assert.equal(signedIn.status, 200);
  assert.equal(new URL((await signedIn.json()).url).pathname, "/admin");
  applyCookies(setupState.jar, signedIn);
  const publicSession = await (await request("/api/auth/session", setupState.jar)).json();
  assert.deepEqual(publicSession.roles, ["master-admin"]);
  assert.ok(!Object.hasOwn(publicSession, "access_token"));

  const rejected = addUser("rejected", { temporary: true, otp: "654321" });
  const rejectedState = await csrfJar();
  const resetCount = resets.length;
  for (const [changes, status, options] of [
    [{ currentPassword: "wrong-synthetic-password" }, 401], [{ otp: "000000" }, 401],
    [{ otp: "" }, 401], [{ csrfToken: "0".repeat(64) }, 403],
    [{ confirmPassword: "synthetic-mismatch" }, 400], [{ unknownField: "synthetic" }, 400],
    [{ newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) }, 400],
    [{}, 403, { headers: { Origin: "https://untrusted.invalid" } }],
  ]) await assertResponse(await update(rejectedState, rejected, changes, options), status, [rejected.password]);
  const disabled = addUser("disabled", { temporary: true, enabled: false });
  await assertResponse(await update(await csrfJar(), disabled), 401);
  const extraActions = addUser("extra-action", { actions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] });
  await assertResponse(await update(await csrfJar(), extraActions), 401);
  assert.deepEqual(extraActions.requiredActions, ["UPDATE_PASSWORD", "CONFIGURE_TOTP"]);
  assert.equal(resets.length, resetCount, "Every rejected proof/input must leave provider credentials unchanged");

  const existing = addUser("existing", { otp: "234567" });
  const originalSession = await browserSession(existing);
  const existingState = await csrfJar(originalSession.jar);
  const beforeChange = resets.length;
  const changed = await update(existingState, existing, { mode: "change" });
  await assertResponse(changed, 200);
  applyCookies(existingState.jar, changed);
  const session = await decode({ token: sessionValue(existingState.jar), secret, salt: cookieName });
  for (const key of ["sub", "auth_time", "step_up_duration_minutes", "step_up_expires_at", "step_up_window_id"]) {
    assert.equal(session[key], originalSession.payload[key], "Password change cannot replace or extend the existing account session");
  }
  assert.equal(existingState.jar.get(lockCookie), "1");
  assert.equal(resets.length, beforeChange + 1);
  assert.ok(!revocations.includes(originalSession.payload.refresh_token), "Only the extra credential-proof session may be revoked");
  const other = addUser("other-user", { role: "operator" });
  await assertResponse(await update(existingState, other, { mode: "change" }), 401);
  assert.equal(resets.length, beforeChange + 1, "A different username cannot retarget the signed-in user's reset");
  await assertResponse(await update(await csrfJar(), existing, { mode: "change",
    newPassword: "synthetic-next-existing", confirmPassword: "synthetic-next-existing" }), 401);
  await assertResponse(await update(existingState, rejected), 409);
  const pending = await csrfJar(new Map([[intentCookie, "synthetic-pending-intent"]]));
  await assertResponse(await update(pending, rejected), 409);

  const concurrent = addUser("concurrent", { temporary: true });
  const concurrentState = await csrfJar();
  let entered;
  let release;
  const reached = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  pauseProof = { subject: concurrent.id, entered, wait };
  const first = update(concurrentState, concurrent);
  try {
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("Concurrent proof did not reach its lease")), 5_000))]);
    await assertResponse(await update(concurrentState, concurrent), 409);
  } finally { release(); pauseProof = undefined; }
  await assertResponse(await first, 200);
  assert.equal(resets.filter((id) => id === concurrent.id).length, 1);

  const outage = addUser("outage", { temporary: true });
  const outageState = await csrfJar();
  serviceUnavailable = true;
  await assertResponse(await update(outageState, outage), 503);
  serviceUnavailable = false;
  leaseUnavailable = true;
  await assertResponse(await update(outageState, outage), 503);
  leaseUnavailable = false;
  assert.ok(!resets.includes(outage.id));
  const uncertain = addUser("uncertain", { temporary: true });
  const uncertainState = await csrfJar();
  // Preserve the browser's submitted proof across a lost response; the
  // synthetic provider mutates its own account object when the write commits.
  const uncertainProof = { currentPassword: uncertain.password };
  loseResetResponses.add(uncertain.id);
  await assertResponse(await update(uncertainState, uncertain, uncertainProof), 503);
  assert.ok(leases.has(uncertain.id), "An ambiguous committed reset must retain its short lease");
  await assertResponse(await update(uncertainState, uncertain, uncertainProof), 409);
  assert.equal(resets.filter((id) => id === uncertain.id).length, 1, "An uncertain reset cannot be retried as a second write");
  console.log("Password-update HTTP checks passed: app-owned master-admin setup and subsequent sign-in; current-password/OTP verification; CSRF, Origin and input rejection; disabled/additional-action denial; identity-bound existing-account changes with session and lock preservation; cross-request leases; provider/coordination outages; and ambiguous-write retry protection.");
} catch (error) {
  const safe = diagnostics.replaceAll(secret, "[redacted]").replaceAll(serviceSecret, "[redacted]")
    .replaceAll(frontendSecret, "[redacted]").replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted token/cookie]");
  console.error(safe);
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
