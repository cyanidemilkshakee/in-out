import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_BODY_MAX_BYTES, AuthRequestError, isSameOriginAuthRequest, prepareAuthRequest, publicAuthSession,
  safeAuthCallbackUrl, safeAuthRedirect, safeAuthResponseUrl,
} from "../lib/authRequestBoundary";
import { issuedAuthSession, isCompletedAdminStepUpToken } from "../lib/authCallbackSession";
import type { StepUpIntent } from "../lib/userManagementStepUp";

const origin = "https://app.invalid";
const endpoint = `${origin}/api/auth/signin/keycloak`;
const formHeaders = { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" };
const form = (body: string, headers: HeadersInit = formHeaders, url = endpoint) => new Request(url, { method: "POST", headers, body });
const errorStatus = (status: number) => (error: unknown) => error instanceof AuthRequestError && error.status === status;

function streamed(body: ReadableStream<Uint8Array>) {
  return new Request(endpoint, { method: "POST", headers: formHeaders, body,
    duplex: "half" } as RequestInit & { duplex: string });
}

test("auth forms keep CSRF and password bytes intact for Auth.js verification", async () => {
  const body = new URLSearchParams({ csrfToken: "synthetic-token", callbackUrl: "/admin/users", password: "  a+b & ☃  " }).toString();
  const result = await prepareAuthRequest(form(body), origin);
  assert.equal(result.body, body);
  assert.equal(new URLSearchParams(result.body).get("password"), "  a+b & ☃  ");
  assert.equal(new URLSearchParams(result.body).get("csrfToken"), "synthetic-token");
  // CSRF remains Auth.js's responsibility; the boundary never fabricates a token.
  assert.equal((await prepareAuthRequest(form("callbackUrl=%2Fadmin"), origin)).body, "callbackUrl=%2Fadmin");
});

test("auth mutations reject missing, opaque, cross-origin, and duplicate Origin headers", async () => {
  for (const supplied of [undefined, "null", "https://other.invalid", `${origin}/path`, `${origin}, ${origin}`]) {
    const headers = new Headers(formHeaders);
    if (supplied === undefined) headers.delete("Origin"); else headers.set("Origin", supplied);
    await assert.rejects(prepareAuthRequest(form("csrfToken=synthetic", headers), origin), errorStatus(403));
  }
  const duplicate = new Headers([["Origin", origin], ["Origin", origin], ["Content-Type", "application/x-www-form-urlencoded"]]);
  await assert.rejects(prepareAuthRequest(form("csrfToken=synthetic", duplicate), origin), errorStatus(403));
  // A normal OIDC GET callback has no Origin header.
  assert.equal((await prepareAuthRequest(new Request(`${origin}/api/auth/callback/keycloak?code=synthetic&state=synthetic`), origin)).origin, origin);
});

test("configured auth origin is exclusive even behind forged or internal proxy URLs", () => {
  const internalUrl = "http://internal-app:3000/api/auth/step-up";
  for (const supplied of [undefined, "null", "http://internal-app:3000", "https://untrusted.invalid", `${origin}/`, `${origin}, ${origin}`]) {
    const headers = new Headers({ "X-Forwarded-Host": "untrusted.invalid", "X-Forwarded-Proto": "https" });
    if (supplied !== undefined) headers.set("Origin", supplied);
    assert.equal(isSameOriginAuthRequest(new Request(internalUrl, { headers }), origin), false);
  }
  assert.equal(isSameOriginAuthRequest(new Request(internalUrl, { headers: { Origin: origin, Host: "untrusted.invalid" } }), origin), true);
  assert.equal(isSameOriginAuthRequest(new Request(internalUrl, { headers: { Origin: origin } }), "not-a-url"), false);
});

test("OIDC sign-in parameters cannot override the server-owned authorization contract", async () => {
  assert.equal((await prepareAuthRequest(form("csrfToken=synthetic", formHeaders, `${endpoint}?prompt=login&max_age=0`), origin)).origin, origin);
  for (const path of ["/api/auth/signin/keycloak", "/api/auth//signin/keycloak/", "/api/auth/signin//keycloak"]) {
    for (const query of ["client_id=other", "redirect_uri=https%3A%2F%2Funtrusted.invalid", "response_type=token",
      "scope=openid%20offline_access", "response_mode=form_post", "state=synthetic", "nonce=synthetic",
      "code_challenge=synthetic", "code_challenge_method=plain", "prompt=none", "max_age=999999", "callbackUrl=%2Fadmin"]) {
      await assert.rejects(prepareAuthRequest(form("csrfToken=synthetic", formHeaders, `${origin}${path}?${query}`), origin), errorStatus(400));
    }
  }
  // Callback protocol parameters are provider responses rather than browser-selected options.
  assert.equal((await prepareAuthRequest(new Request(`${origin}/api/auth/callback/keycloak?code=synthetic&state=synthetic&iss=https%3A%2F%2Fidentity.invalid`), origin)).origin, origin);
});

test("auth headers reject ambiguous media types, lengths, transfer encoding and redirect flags", async () => {
  for (const contentType of ["text/plain", "multipart/form-data; boundary=x", "application/json, application/json", "application/x-www-form-urlencoded; charset=iso-8859-1"]) {
    await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "Content-Type": contentType }), origin), errorStatus(415));
  }
  for (const length of ["-1", "12, 12", "1e3", "NaN", "99999999999999999999"]) {
    await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "Content-Length": length }), origin), errorStatus(400));
  }
  await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "Content-Length": "8193" }), origin), errorStatus(413));
  await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "Content-Length": "0" }), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "Transfer-Encoding": "chunked", "Content-Length": "11" }), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, "X-Auth-Return-Redirect": "1, 1" }), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("csrfToken=x", { ...formHeaders, Host: "app.invalid, attacker.invalid" }), origin), errorStatus(400));
});

test("auth forms enforce the 8 KiB byte bound with and without Content-Length", async () => {
  const exact = "padding=" + "x".repeat(AUTH_BODY_MAX_BYTES - "padding=".length);
  assert.equal((await prepareAuthRequest(form(exact, { ...formHeaders, "Content-Length": String(AUTH_BODY_MAX_BYTES) }), origin)).body, exact);
  const encoder = new TextEncoder();
  await assert.rejects(prepareAuthRequest(streamed(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(exact)); controller.enqueue(encoder.encode("x")); controller.close();
  } })), origin), errorStatus(413));
  await assert.rejects(prepareAuthRequest(form("padding=" + "☃".repeat(3000)), origin), errorStatus(413));
});

test("a stalled or trickling auth form hits one deadline without awaiting cancellation", async () => {
  let canceled = false;
  const request = streamed(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("csrfToken=")); },
    cancel() { canceled = true; return new Promise<void>(() => {}); },
  }));
  const started = performance.now();
  await assert.rejects(prepareAuthRequest(request, origin, 20), errorStatus(408));
  assert.ok(performance.now() - started < 1000);
  assert.equal(canceled, true);
});

test("malformed UTF-8 and percent-encoded form data cannot reach Auth.js", async () => {
  await assert.rejects(prepareAuthRequest(streamed(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0xc0, 0xaf])); controller.close();
  } })), origin), errorStatus(400));
  for (const body of ["csrfToken=%", "csrfToken=%ZZ", "password=%C0%AF"]) {
    await assert.rejects(prepareAuthRequest(form(body), origin), errorStatus(400));
  }
});

test("ambiguous query/form parameters are rejected before security fields are collapsed", async () => {
  for (const body of ["csrfToken=first&csrfToken=second", "callbackUrl=%2Fadmin&callbackUrl=%2Fterminal", "username=a&%75sername=b", "otp=123456&otp=654321"]) {
    await assert.rejects(prepareAuthRequest(form(body), origin), errorStatus(400));
  }
  await assert.rejects(prepareAuthRequest(new Request(`${origin}/api/auth/callback/keycloak?state=one&state=two`), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("callbackUrl=%2Fadmin", formHeaders, `${endpoint}?callbackUrl=%2Fterminal`), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("otp=123456", formHeaders, `${origin}/api/auth/callback/credentials?otp=654321`), origin), errorStatus(400));
  await assert.rejects(prepareAuthRequest(form("%00name=x"), origin), errorStatus(400));
});

test("Auth.js JSON session updates remain bounded and keep their CSRF field", async () => {
  const body = JSON.stringify({ csrfToken: "synthetic", data: { label: "Test" } });
  assert.equal((await prepareAuthRequest(form(body, { Origin: origin, "Content-Type": "application/json; charset=UTF-8" }, `${origin}/api/auth/session`), origin)).body, body);
  for (const invalid of ["null", "[]", '"string"', "{"]) {
    await assert.rejects(prepareAuthRequest(form(invalid, { Origin: origin, "Content-Type": "application/json" }), origin), errorStatus(400));
  }
});

test("return URLs reject external, backslash, control, and repeatedly encoded destinations", () => {
  for (const candidate of ["//other.invalid", "/\\other.invalid", "https://other.invalid/admin", "javascript:alert(1)",
    "https://user:password@app.invalid/admin", "/admin\nusers", "/admin%0Ausers", "/%5cother.invalid", "/%255cother.invalid",
    "/%25252525255cother.invalid", "/%2f%2fother.invalid", "/%252f%252fother.invalid", " /admin", "/admin%7F", "/bad%ZZ"]) {
    assert.throws(() => safeAuthCallbackUrl(candidate, origin), errorStatus(400));
    assert.equal(safeAuthRedirect(candidate, origin), `${origin}/admin`);
  }
  assert.equal(safeAuthCallbackUrl("/admin/registry?tab=alerts&subject=person%2F1", origin), `${origin}/admin/registry?tab=alerts&subject=person%2F1`);
  assert.equal(safeAuthRedirect(`${origin}/admin/users`, origin), `${origin}/admin/users`);
  assert.equal(safeAuthRedirect(undefined, origin, "/terminal"), `${origin}/terminal`);
});

test("only the configured OAuth authorization endpoint may leave the app", () => {
  const authorizationUrl = "https://identity.invalid/realms/inout/protocol/openid-connect/auth";
  assert.equal(safeAuthResponseUrl(`${authorizationUrl}?state=synthetic&code_challenge=synthetic`, origin, authorizationUrl), `${authorizationUrl}?state=synthetic&code_challenge=synthetic`);
  for (const candidate of ["https://other.invalid/", "https://identity.invalid/admin/", `${authorizationUrl}#unexpected`, "https://user:password@identity.invalid/realms/inout/protocol/openid-connect/auth"]) {
    assert.throws(() => safeAuthResponseUrl(candidate, origin, authorizationUrl), errorStatus(400));
  }
  assert.throws(() => safeAuthResponseUrl(authorizationUrl, origin), errorStatus(400));
});

test("public auth sessions omit provider tokens, response bodies and private window identifiers", () => {
  const result = publicAuthSession({
    user: { name: "Test", email: "test@example.invalid", image: null, access_token: "synthetic-secret", password: "synthetic-secret" },
    subject: "synthetic-subject", expires: "2030-01-01", provider: "keycloak", roles: ["admin", 1],
    authTime: 2000, stepUpExpiresAt: 2300, stepUpDurationMinutes: 5, stepUpExtensionSeconds: 0,
    access_token: "synthetic-secret", refresh_token: "synthetic-secret", id_token: "synthetic-secret",
    stepUpWindowId: "synthetic-private-id", step_up_intent_id: "synthetic-private-id", response: { password: "synthetic-secret" },
    error: "synthetic-secret",
  });
  assert.deepEqual(result, {
    user: { name: "Test", email: "test@example.invalid", image: null }, subject: "synthetic-subject", expires: "2030-01-01",
    provider: "keycloak", roles: ["admin"], authTime: 2000, stepUpExpiresAt: 2300, stepUpDurationMinutes: 5, stepUpExtensionSeconds: 0,
  });
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  assert.equal(publicAuthSession(null), null);
  assert.deepEqual(publicAuthSession({ error: "RefreshTokenError" }), { error: "RefreshTokenError" });
});

test("new response session chunks must be bounded and complete without mixing old cookie forms", () => {
  const salt = "authjs.session-token";
  const first = "a".repeat(3936);
  const last = "b".repeat(200);
  const reconstructed = issuedAuthSession([
    `${salt}=; Path=/; Max-Age=0`, `${salt}.0=${first}; Path=/; HttpOnly`, `${salt}.1=${last}; Path=/; HttpOnly`,
  ], false);
  assert.deepEqual(reconstructed, { value: first + last, salt });
  assert.deepEqual(issuedAuthSession([`__Secure-${salt}=synthetic.token; Path=/; Secure; HttpOnly`], true),
    { value: "synthetic.token", salt: `__Secure-${salt}` });
  for (const cookies of [[], [`${salt}=; Path=/; Max-Age=0`], [`${salt}.1=${last}; Path=/`],
    [`${salt}.0=${first}; Path=/`, `${salt}.2=${last}; Path=/`],
    [`${salt}=old.token; Path=/`, `${salt}.0=${first}; Path=/`],
    [`${salt}.0=short; Path=/`, `${salt}.1=${last}; Path=/`],
    [`${salt}.0=${"x".repeat(3937)}; Path=/`],
    [`${salt}.0=not%a%token; Path=/`],
    Array.from({ length: 9 }, (_, index) => `${salt}.${index}=${first}; Path=/`),
  ]) assert.equal(issuedAuthSession(cookies, false), null);
  assert.equal(issuedAuthSession([`${salt}=synthetic.token; Path=/; HttpOnly`], true), null);
});

const callbackNow = 2_000_000;
const callbackSubject = "synthetic-admin";
const callbackIntent: StepUpIntent = {
  issuedAt: callbackNow - 1000, durationMinutes: 5, subject: callbackSubject,
  intentId: "b6054cab-bd97-4b4e-845b-a86dcf7a3910",
};
const callbackBearer = (subject = callbackSubject, roles = ["admin"]) =>
  `header.${Buffer.from(JSON.stringify({ sub: subject, realm_access: { roles } })).toString("base64url")}.signature`;
const callbackToken: Record<string, unknown> = {
  sub: callbackSubject, access_token: callbackBearer(), roles: ["admin"], expires_at: 2600,
  auth_time: 2000, step_up_expires_at: 2300, step_up_duration_minutes: 5, step_up_extension_seconds: 0,
  step_up_window_id: "b6054cab-bd97-4b4e-845b-a86dcf7a3911", step_up_intent_id: callbackIntent.intentId,
};

test("step-up cleanup requires the exact admin account and newly consumed intent", () => {
  assert.equal(isCompletedAdminStepUpToken(callbackToken, callbackIntent, callbackNow), true);
  const masterAdminToken = {
    ...callbackToken,
    roles: ["master-admin"],
    access_token: callbackBearer(callbackSubject, ["master-admin"]),
  };
  assert.equal(isCompletedAdminStepUpToken(masterAdminToken, callbackIntent, callbackNow), true);
  for (const patch of [
    { sub: "other-admin" }, { access_token: callbackBearer("other-admin") },
    { roles: ["operator"] }, { access_token: callbackBearer(callbackSubject, ["operator"]) },
    { step_up_intent_id: undefined }, { step_up_intent_id: "b6054cab-bd97-4b4e-845b-a86dcf7a3999" },
    { step_up_window_id: "invalid" }, { step_up_window_id: undefined },
    { error: "RefreshTokenError" }, { expires_at: 2000 }, { expires_at: "2600" },
  ]) assert.equal(isCompletedAdminStepUpToken({ ...callbackToken, ...patch }, callbackIntent, callbackNow), false);
  assert.equal(isCompletedAdminStepUpToken(null, callbackIntent, callbackNow), false);
});

test("step-up cleanup rejects an old login or mismatched chosen/resulting window", () => {
  for (const patch of [
    { auth_time: 1990 }, { auth_time: 2031 }, { auth_time: "2000" },
    { step_up_expires_at: 2301 }, { step_up_duration_minutes: 10 },
    { step_up_extension_seconds: undefined }, { step_up_extension_seconds: 1 },
  ]) assert.equal(isCompletedAdminStepUpToken({ ...callbackToken, ...patch }, callbackIntent, callbackNow), false);
  assert.equal(isCompletedAdminStepUpToken(callbackToken, callbackIntent, 2_300_000), false);
  const extendingIntent = { ...callbackIntent, baseExpiresAt: 2200 };
  assert.equal(isCompletedAdminStepUpToken({ ...callbackToken, step_up_expires_at: 2500, step_up_extension_seconds: 200 }, extendingIntent, callbackNow), true);
  assert.equal(isCompletedAdminStepUpToken(callbackToken, extendingIntent, callbackNow), false);
});
