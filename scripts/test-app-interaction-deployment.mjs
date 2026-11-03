// Explicit local deployment smoke check. It creates/deletes only its own
// synthetic operator; it never scans a barcode or creates organization data.
// Run only after isolated provider verification and coordinated app cutover:
// node scripts/test-app-interaction-deployment.mjs --local
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--local") {
  console.error("Usage: node scripts/test-app-interaction-deployment.mjs --local");
  process.exit(2);
}

let stage = "initialization";
let cleanupFailed = false;
async function main() {
  let connection = await connectLocalKeycloak();
  let adminAuthenticatedAt = Date.now();
  async function admin(path, options) {
    // Do not replay writes after an authentication failure. Establish a fresh
    // maintenance connection before the short master token can expire.
    if (Date.now() - adminAuthenticatedAt >= 40_000) {
      connection = await connectLocalKeycloak();
      adminAuthenticatedAt = Date.now();
    }
    return connection.api(path, options);
  }

  const origin = new URL(process.env.AUTH_URL || `http://app.localhost:${process.env.APP_PORT || "1008"}`);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || origin.hostname.endsWith(".localhost");
  assert.ok(loopback && origin.protocol === "http:" && !origin.username && !origin.password &&
    !origin.search && !origin.hash && origin.pathname === "/", "Only a loopback HTTP application origin is allowed");
  const transport = new URL(origin);
  transport.hostname = "127.0.0.1";
  const cookies = new Map();
  let lastCredentialPostAt = 0;
  async function request(path, { method = "GET", body, contentType, returnRedirect = false } = {}) {
    assert.ok(path.startsWith("/") && !path.startsWith("//"));
    if (method === "POST") {
      const delay = 650 - (Date.now() - lastCredentialPostAt);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      lastCredentialPostAt = Date.now();
    }
    const response = await fetch(new URL(path, transport), {
      method, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { Host: origin.host, ...(method === "POST" ? { Origin: origin.origin } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(returnRedirect ? { "X-Auth-Return-Redirect": "1" } : {}),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}) }, body,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [first] = cookie.split(";", 1);
      const delimiter = first.indexOf("=");
      const name = first.slice(0, delimiter);
      if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, first.slice(delimiter + 1));
    }
    return response;
  }
  async function csrf() {
    const response = await request("/api/auth/csrf");
    assert.equal(response.status, 200);
    const token = (await response.json()).csrfToken;
    assert.match(token, /^[a-f0-9]{64}$/);
    return token;
  }
  async function publicSession() {
    const response = await request("/api/auth/session");
    assert.equal(response.status, 200);
    const session = await response.json();
    if (session) {
      assert.ok(!Object.hasOwn(session, "access_token"));
      assert.ok(!Object.hasOwn(session, "refresh_token"));
    }
    return session;
  }

  const username = "interaction-deployment-" + randomBytes(12).toString("hex");
  const temporary = randomBytes(32).toString("base64url");
  const password = randomBytes(32).toString("base64url");
  const changedPassword = randomBytes(32).toString("base64url");
  let subject;
  let createAttempted = false;
  async function signIn(value) {
    const response = await request("/api/auth/callback/credentials", { method: "POST", returnRedirect: true,
      contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({
        username, password: value, csrfToken: await csrf(), callbackUrl: origin.origin + "/terminal",
      }) });
    assert.equal(response.status, 200);
    const destination = new URL((await response.json()).url, origin);
    assert.equal(destination.origin, origin.origin);
    return destination;
  }
  async function update(mode, currentPassword, newPassword) {
    const response = await request("/api/auth/password/update", { method: "POST", contentType: "application/json",
      body: JSON.stringify({ mode, username, currentPassword, newPassword, confirmPassword: newPassword, csrfToken: await csrf() }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }

  try {
    stage = "synthetic operator creation";
    createAttempted = true;
    const created = await admin("/users", { method: "POST", body: { username, enabled: true,
      email: username + "@example.invalid", emailVerified: true, firstName: "Interaction", lastName: "Deployment fixture",
      requiredActions: ["UPDATE_PASSWORD"], credentials: [{ type: "password", value: temporary, temporary: true }] } });
    assert.equal(created.status, 201);
    subject = new URL(created.headers.get("location")).pathname.split("/").at(-1);
    assert.ok(subject);
    const role = await (await admin("/roles/operator")).json();
    assert.equal((await admin(`/users/${encodeURIComponent(subject)}/role-mappings/realm`, { method: "POST", body: [role] })).status, 204);

    stage = "temporary account sign-in";
    const incomplete = await signIn(temporary);
    assert.equal(incomplete.searchParams.get("code"), "account_setup_required");
    assert.equal(await publicSession(), null);
    console.log("PASS: deployed app requires temporary-password setup without creating a session");

    stage = "in-app temporary password update";
    await update("setup", temporary, password);
    assert.equal(await publicSession(), null);
    console.log("PASS: deployed inline password setup completes and leaves ordinary sign-in required");

    stage = "new-password sign-in";
    const accepted = await signIn(password);
    assert.ok(!accepted.searchParams.has("error"));
    const before = await publicSession();
    assert.equal(before.subject, subject);
    assert.ok(before.roles.includes("operator"));
    assert.ok(!before.roles.includes("zone-admin") && !before.roles.includes("master-admin"));
    console.log("PASS: deployed app signs in the synthetic operator through the real interaction provider");

    stage = "signed-in password change";
    await update("change", password, changedPassword);
    const after = await publicSession();
    assert.equal(after.subject, before.subject);
    assert.deepEqual(after.roles, before.roles);
    assert.equal(after.authTime, before.authTime);
    assert.equal(after.stepUpExpiresAt, before.stepUpExpiresAt);
    console.log("PASS: deployed own-password change preserves application identity and authentication window");

    stage = "application logout";
    const logout = await request("/logout", { method: "POST", contentType: "application/x-www-form-urlencoded", body: "" });
    assert.equal(logout.status, 303);
    const destination = new URL(logout.headers.get("location"), origin);
    assert.equal(destination.origin, origin.origin);
    assert.equal(destination.pathname, "/login");
    assert.equal(await publicSession(), null);
    console.log("PASS: deployed app logout clears the synthetic browser session");

    stage = "changed-password sign-in";
    const changedSignIn = await signIn(changedPassword);
    assert.ok(!changedSignIn.searchParams.has("error"));
    assert.equal((await publicSession()).subject, subject);
    const finalLogout = await request("/logout", { method: "POST", contentType: "application/x-www-form-urlencoded", body: "" });
    assert.equal(finalLogout.status, 303);
    assert.equal(await publicSession(), null);
    console.log("PASS: the changed password signs in successfully and its session is cleared");
  } finally {
    try {
      // A create response can be lost after commit. An exact lookup of this
      // unique generated username permits cleanup without retrying creation.
      if (createAttempted && !subject) {
        const matches = await (await admin("/users?" + new URLSearchParams({ username, exact: "true", max: "2" }))).json();
        assert.ok(Array.isArray(matches) && matches.length <= 1);
        if (matches.length) {
          assert.equal(matches[0].username, username);
          subject = matches[0].id;
        }
      }
      if (subject) {
        const owned = await (await admin(`/users/${encodeURIComponent(subject)}`)).json();
        assert.equal(owned.username, username, "Cleanup must target only this run's synthetic operator");
        assert.equal((await admin(`/users/${encodeURIComponent(subject)}`, { method: "DELETE" })).status, 204);
        console.log("PASS: synthetic Keycloak account removed");
      }
    } catch {
      cleanupFailed = true;
      throw new Error("Synthetic account cleanup failed");
    }
  }
}

main().catch(() => {
  // API exceptions/assertions can contain identifiers or response bodies.
  console.error(`FAILED: ${stage}.${cleanupFailed ? " Synthetic account cleanup needs review." : " Synthetic account cleanup completed or was unnecessary."}`);
  process.exitCode = 1;
});
