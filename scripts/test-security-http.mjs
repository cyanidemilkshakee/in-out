// Synthetic localhost-only security probes. No configured service is contacted.
// Run from the repository root after `npm run build`:
//   node scripts/test-security-http.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { encode } from "next-auth/jwt";

const secret = randomBytes(32).toString("base64url");
const cookieName = "authjs.session-token";
const received = [];
const stub = createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  received.push({ method: req.method, path: req.url });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ id: "synthetic", barcode: "synthetic", kind: "employee", data: {} }));
});
await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const appUrl = `http://localhost:${port}`;
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, AUTH_SECRET: secret, AUTH_URL: appUrl, AUTH_TRUST_HOST: "true",
    KEYCLOAK_CLIENT_ID: "synthetic", KEYCLOAK_CLIENT_SECRET: "synthetic",
    KEYCLOAK_ISSUER: `${stubUrl}/realms/synthetic`, KEYCLOAK_ISSUER_PUBLIC: `${stubUrl}/realms/synthetic`,
    KEYCLOAK_JWKS_BASE: `${stubUrl}/realms/synthetic`, PYTHON_API_URL: stubUrl, NEXT_TELEMETRY_DISABLED: "1" },
});
// Never print session cookies, bearer tokens, or application diagnostics.
app.stdout.resume();
app.stderr.resume();
let spawnError;
app.on("error", error => { spawnError = error; });
const evidence = [];
const probe = (name, result) => { evidence.push({ name, ...result }); };
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (spawnError) throw spawnError;
    if (app.exitCode !== null) throw new Error("Isolated app exited before startup");
    try {
      ready = (await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch { /* Wait for the synthetic app only. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Isolated production build must be ready");
  const access = role => `synthetic.${Buffer.from(JSON.stringify({ realm_access: { roles: [role] } })).toString("base64url")}.synthetic`;
  const session = role => encode({ secret, salt: cookieName, token: {
    sub: "synthetic-user", name: "Synthetic User", roles: [role], provider: "keycloak",
    access_token: access(role), refresh_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 600,
  } });
  const adminCookie = `${cookieName}=${await session("admin")}`;
  const operatorCookie = `${cookieName}=${await session("operator")}`;
  for (const path of ["/admin/permissions", "/admin/registry", "/terminal"]) {
    const response = await fetch(`${appUrl}${path}`, { headers: { Cookie: adminCookie }, redirect: "manual" });
    await response.arrayBuffer();
    const csp = response.headers.get("content-security-policy");
    const xfo = response.headers.get("x-frame-options");
    assert.equal(response.status, 200); assert.match(csp, /frame-ancestors 'none'/); assert.equal(xfo, "DENY"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    probe("authenticated_page_framing", { path, status: response.status, csp, xFrameOptions: xfo,
      frameProtectionAbsent: !xfo && !/frame-ancestors/i.test(csp || "") });
  }
  const operatorAdmin = await fetch(`${appUrl}/admin/permissions`, { headers: { Cookie: operatorCookie }, redirect: "manual" });
  assert.equal(operatorAdmin.status, 307);
  assert.ok(operatorAdmin.headers.get("location").endsWith("/terminal"));
  probe("operator_admin_page_denied", { status: operatorAdmin.status });

  const publicSession = await fetch(`${appUrl}/api/auth/session`, { headers: { Cookie: adminCookie } });
  const publicBody = await publicSession.json();
  assert.ok(!publicBody.access_token && !publicBody.refresh_token && !publicBody.stepUpWindowId);
  probe("public_session_secrets_removed", { status: publicSession.status, passed: true });

  const before = received.length;
  const crossOrigin = await fetch(`${appUrl}/api/data`, { method: "POST", headers: {
    Cookie: adminCookie, Origin: "http://attacker.invalid", "Content-Type": "application/json",
  }, body: JSON.stringify({ action: "createEmployee", input: {} }) });
  assert.equal(crossOrigin.status, 403);
  assert.equal(received.length, before);
  probe("cross_origin_write_rejected_before_upstream", { status: crossOrigin.status });

  const invalidIdentity = await fetch(`${appUrl}/api/keycloak`, { method: "POST", headers: {
    Cookie: adminCookie, Origin: appUrl, "Content-Type": "application/json",
  }, body: JSON.stringify({ action: "createUser", input: {} }) });
  assert.equal(invalidIdentity.status, 403);
  assert.equal(received.length, before);
  probe("identity_write_without_step_up_denied", { status: invalidIdentity.status });

  // Demonstrates path construction, not an authorization bypass: FastAPI still
  // applies the destination route's own role and step-up dependencies.
  const traversed = await fetch(`${appUrl}/api/data`, { method: "POST", headers: {
    Cookie: adminCookie, Origin: appUrl, "Content-Type": "application/json",
  }, body: JSON.stringify({ action: "updatePerson", personId: "../../keycloak/users/synthetic", patch: {} }) });
  await traversed.arrayBuffer();
  assert.equal(traversed.status, 400); assert.equal(received.length, before);
  probe("traversal_command_id_rejected_before_upstream", {
    status: traversed.status, upstreamContacted: false,
    authorizationBypassProven: false,
  });
  console.log(JSON.stringify({ environment: "synthetic localhost app and upstream", probes: evidence }, null, 2));
} finally {
  app.kill();
  stub.closeAllConnections();
  await new Promise(resolve => stub.close(resolve));
}
