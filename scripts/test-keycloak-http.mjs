// Run after npm run build. Starts an isolated app with synthetic sessions and
// local identity/API stubs; never contacts the configured real Keycloak realm.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { encode, decode } from "next-auth/jwt";

const secret = randomBytes(32).toString("base64url");
const cookieName = "authjs.session-token";
const accessToken = (role) => `header.${Buffer.from(JSON.stringify({ realm_access: { roles: [role] } })).toString("base64url")}.signature`;
let refreshCalls = 0;
const upstreamTokens = [];

const upstream = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/realms/inout/protocol/openid-connect/token") {
    refreshCalls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
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
  res.writeHead(404).end(JSON.stringify({ detail: "Unexpected test upstream request" }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const appUrl = `http://127.0.0.1:${port}`;

const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
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

function request(path, cookie) {
  return fetch(`${appUrl}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(20_000) });
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
  assert.ok(html.includes("Account security") && html.includes("Sign out"));

  const denied = await request("/api/profile", await sessionCookie({ refresh_token: "revoked" }));
  assert.equal(denied.status, 401);
  const revokedCookie = updatedCookie(denied);
  const attempts = refreshCalls;
  assert.equal((await request("/api/profile", revokedCookie)).status, 401);
  assert.equal(refreshCalls, attempts, "Invalid refresh grants must not be retried after invalidation is persisted");

  const operator = await sessionCookie({ roles: ["operator"], access_token: accessToken("operator"), expires_at: Math.floor(Date.now() / 1000) + 300 });
  const redirected = await request("/admin/profile", operator);
  assert.equal(new URL(redirected.headers.get("location")).pathname, "/terminal");
  console.log("Keycloak HTTP checks passed: public-session isolation, single refresh, cookie persistence, upstream forwarding, invalidation, account redirect, role routing, account controls.");
} catch (error) {
  // The server uses only synthetic credentials, but redact them even in errors.
  console.error(diagnostics.replaceAll(secret, "[redacted]").replace(/Bearer\s+\S+/g, "Bearer [redacted]"));
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
