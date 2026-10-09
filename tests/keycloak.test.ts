import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash, createHmac } from "node:crypto"
import { authTimeFromAccessToken, keycloakLogoutUrl, keycloakSession, refreshKeycloakToken, rolesFromAccessToken, type RoleToken } from "../lib/keycloakSession"
import { completedStepUpWindow, isActiveUserManagementStepUp, isStepUpDurationMinutes, isSuccessfulUserManagementCallback, signStepUpIntent, signStepUpProof, USER_MANAGEMENT_STEP_UP_DURATIONS, verifyStepUpIntent } from "../lib/userManagementStepUp"

const now = 2_000_000
const config = { issuer: "http://keycloak:1105/realms/inout", clientId: "inout-frontend", clientSecret: "test-secret" }
const accessToken = (roles: unknown) => `header.${Buffer.from(JSON.stringify({ realm_access: { roles } })).toString("base64url")}.signature`
const expired: RoleToken = { access_token: accessToken(["admin"]), refresh_token: "refresh", expires_at: 1, roles: ["admin"] }

test("expired sessions without refresh tokens fail closed", async () => {
  const result = await refreshKeycloakToken({ ...expired, refresh_token: undefined }, config, fetch, now)
  assert.equal(result.access_token, undefined)
  assert.deepEqual(result.roles, [])
  assert.equal(result.error, "RefreshTokenError")
})

test("valid sessions make no token request", async () => {
  const token = { ...expired, expires_at: now / 1000 + 300 }
  const result = await refreshKeycloakToken(token, config, async () => { throw new Error("Unexpected refresh") }, now)
  assert.equal(result, token)
})

test("refresh updates roles and preserves a refresh token when none is returned", async () => {
  const result = await refreshKeycloakToken(expired, config, async (url, init) => {
    assert.equal(url, `${config.issuer}/protocol/openid-connect/token`)
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get("grant_type"), "refresh_token")
    assert.equal(body.get("client_secret"), "test-secret")
    return Response.json({ access_token: accessToken(["operator"]), expires_in: 300, token_type: "Bearer" })
  }, now)
  assert.deepEqual(result.roles, ["operator"])
  assert.equal(result.refresh_token, "refresh")
  assert.equal(result.expires_at, now / 1000 + 300)
})

test("rotated refresh tokens are retained", async () => {
  const result = await refreshKeycloakToken(expired, config, async () => Response.json({ access_token: accessToken(["admin"]), refresh_token: "rotated", expires_in: 300, token_type: "Bearer" }), now)
  assert.equal(result.refresh_token, "rotated")
})

test("revoked sessions clear credentials and do not retry the invalid grant", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ error: "invalid_grant" }, { status: 400 }) }
  const result = await refreshKeycloakToken(expired, config, fetcher, now)
  const retry = await refreshKeycloakToken(result, config, fetcher, now)
  assert.equal(calls, 1)
  assert.equal(retry.access_token, undefined)
  assert.equal(retry.refresh_token, undefined)
  assert.deepEqual(retry.roles, [])
})

test("malformed refresh responses and network failures cannot extend sessions", async () => {
  for (const response of [{}, { access_token: "abc", expires_in: "300", token_type: "Bearer" }, { access_token: "abc", expires_in: -1, token_type: "Bearer" }, { access_token: "abc", expires_in: 300, token_type: "DPoP" }, { access_token: "abc", expires_in: 300, token_type: "Bearer", refresh_token: 1 }]) {
    const result = await refreshKeycloakToken(expired, config, async () => Response.json(response), now)
    assert.equal(result.error, "RefreshTokenError")
    assert.equal(result.access_token, undefined)
  }
  const result = await refreshKeycloakToken(expired, config, async () => { throw new Error("timeout") }, now)
  assert.equal(result.error, "RefreshTokenError")
})

test("public sessions omit provider credentials while the server can forward access tokens", () => {
  const session = { user: { name: "Alice" }, expires: "2030-01-01" }
  const publicSession = keycloakSession(session, expired, false)
  assert.equal("access_token" in publicSession, false)
  assert.equal("refresh_token" in publicSession, false)
  assert.deepEqual(publicSession.roles, ["admin"])
  assert.equal(keycloakSession(session, expired, true).access_token, expired.access_token)
  assert.equal(keycloakSession(session, expired, true).refresh_token, expired.refresh_token)
})

test("malformed role claims never grant access", () => {
  for (const value of [null, "malformed", accessToken("admin"), accessToken(null)]) assert.deepEqual(rolesFromAccessToken(value), [])
  assert.deepEqual(rolesFromAccessToken(accessToken(["operator", 1])), ["operator"])
})

test("auth time is extracted only from valid numeric claims", () => {
  const token = `header.${Buffer.from(JSON.stringify({ auth_time: 1234 })).toString("base64url")}.signature`
  assert.equal(authTimeFromAccessToken(token), 1234)
  assert.equal(authTimeFromAccessToken(accessToken(["admin"])), undefined)
})

test("step-up intent is signed, short-lived, and cannot be tampered with", async () => {
  const now = 2_000_000
  const intent = await signStepUpIntent(now, "test-secret")
  assert.deepEqual(await verifyStepUpIntent(intent, "test-secret", now + 60_000), { issuedAt: now, durationMinutes: 5 })
  assert.equal(await verifyStepUpIntent(`${now}.tampered`, "test-secret", now), null)
  assert.equal(await verifyStepUpIntent(intent, "test-secret", now + 11 * 60_000), null)
})

test("all six step-up durations are signed and altered durations are rejected", async () => {
  const secret = "test-secret"
  for (const durationMinutes of USER_MANAGEMENT_STEP_UP_DURATIONS) {
    const intent = await signStepUpIntent(now, secret, durationMinutes)
    assert.deepEqual(await verifyStepUpIntent(intent, secret, now), { issuedAt: now, durationMinutes })
    const [encoded, signature] = intent.split(".")
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, "base64url").toString()), durationMinutes: 60 })).toString("base64url")
    if (durationMinutes !== 60) assert.equal(await verifyStepUpIntent(`${altered}.${signature}`, secret, now), null)
    assert.equal(await verifyStepUpIntent(intent, "other-secret", now), null)
    assert.equal(await verifyStepUpIntent(intent, secret, now + 600_000), null)
    assert.equal(await verifyStepUpIntent(intent, secret, now - 30_001), null)
  }
  for (const invalid of [undefined, null, true, "5", 0, 6, 45, 61, 5.5, NaN, Infinity]) assert.equal(isStepUpDurationMinutes(invalid), false)
  for (const invalid of ["malformed", ".signature", "payload.signature", "1.abc.def"]) assert.equal(await verifyStepUpIntent(invalid, secret, now), null)
})

test("fresh login sets a fixed step-up expiry from authentication time", () => {
  const authTime = now / 1_000
  for (const durationMinutes of USER_MANAGEMENT_STEP_UP_DURATIONS) {
    const intent = { issuedAt: now - 1_000, durationMinutes }
    const window = completedStepUpWindow(intent, authTime, now + 2_000)!
    assert.equal(window.expiresAt, authTime + durationMinutes * 60)
    const session = { authTime, stepUpExpiresAt: window.expiresAt, stepUpDurationMinutes: durationMinutes }
    assert.equal(isActiveUserManagementStepUp(session, window.expiresAt * 1_000 - 1), true)
    assert.equal(isActiveUserManagementStepUp(session, window.expiresAt * 1_000), false)
    assert.equal(isActiveUserManagementStepUp({ ...session, stepUpExpiresAt: window.expiresAt + 60 }, now), false)
    assert.equal(completedStepUpWindow(intent, authTime - 10, now), undefined)
    assert.equal(completedStepUpWindow(intent, authTime + 31, now), undefined)
  }
  for (const invalid of [undefined, null, true, "2000", -1, NaN, Infinity, 2000.5]) {
    assert.equal(completedStepUpWindow({ issuedAt: now, durationMinutes: 5 }, invalid, now), undefined)
    assert.equal(isActiveUserManagementStepUp({ authTime: invalid, stepUpExpiresAt: 2300, stepUpDurationMinutes: 5 }, now), false)
  }
  assert.equal(isActiveUserManagementStepUp({ authTime, stepUpExpiresAt: 2300 }, now), false)
})

test("server step-up proofs bind the selected expiry to the exact bearer token", async () => {
  const token = "synthetic-access-token"
  const secret = "test-secret"
  const session = { authTime: 2000, stepUpExpiresAt: 5600, stepUpDurationMinutes: 60 }
  const [payload, signature] = (await signStepUpProof(session, token, secret, now + 600_000)).split(".")
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    issuedAt: 2600, authTime: 2000, expiresAt: 5600, durationMinutes: 60,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  })
  assert.equal(signature, createHmac("sha256", secret).update(`inout:user-management-step-up:v1.${payload}`).digest("base64url"))
  await assert.rejects(signStepUpProof(session, token, secret, 5_600_000))
  await assert.rejects(signStepUpProof(session, token, "", now))
})

test("access-token refresh preserves the selected step-up window without renewing it", async () => {
  const stepUp = { ...expired, auth_time: 1900, step_up_expires_at: 5500, step_up_duration_minutes: 60 }
  const result = await refreshKeycloakToken(stepUp, config, async () => Response.json({ access_token: accessToken(["admin"]), expires_in: 300, token_type: "Bearer" }), now)
  assert.equal(result.step_up_expires_at, 5500)
  assert.equal(result.step_up_duration_minutes, 60)
  const session = keycloakSession({ user: {}, expires: "2030-01-01" }, result, false)
  assert.equal(session.stepUpExpiresAt, 5500)
  assert.equal(session.stepUpDurationMinutes, 60)
  assert.equal("access_token" in session, false)
})

test("only a successful fresh callback clears the user-management lock", () => {
  const requestUrl = "http://internal:3000/api/auth/callback/keycloak"
  const authUrl = "https://app.test"
  const cookies = ["authjs.session-token=new-session; Path=/; HttpOnly"]
  assert.equal(isSuccessfulUserManagementCallback("https://app.test/admin/users", requestUrl, cookies, authUrl), true)
  assert.equal(isSuccessfulUserManagementCallback("/admin/users", requestUrl, ["__Secure-authjs.session-token.0=chunk; Path=/; Secure"], authUrl), true)
  for (const destination of ["/login?error=OAuthCallbackError", "/login", "/api/auth/error", "/admin/users?error=OAuthCallbackError", "https://untrusted.test/admin/users", "/admin/profile"]) {
    assert.equal(isSuccessfulUserManagementCallback(destination, requestUrl, cookies, authUrl), false)
  }
  for (const invalidCookies of [[], ["authjs.pkce.code_verifier=state; Path=/"], ["authjs.session-token=; Path=/; Max-Age=0"], ["authjs.session-token=old; Path=/; Max-Age=0"]]) {
    assert.equal(isSuccessfulUserManagementCallback("/admin/users", requestUrl, invalidCookies, authUrl), false)
  }
})

test("SSO logout uses the public realm and a fixed local return path", () => {
  const url = new URL(keycloakLogoutUrl("https://identity.test/realms/inout/", "inout-frontend", "https://app.test"))
  assert.equal(url.origin, "https://identity.test")
  assert.equal(url.pathname, "/realms/inout/protocol/openid-connect/logout")
  assert.equal(url.searchParams.get("client_id"), "inout-frontend")
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), "https://app.test/login")
  assert.equal(url.searchParams.has("refresh_token"), false)
})
