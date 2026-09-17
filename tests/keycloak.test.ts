import assert from "node:assert/strict"
import { test } from "node:test"
import { keycloakLogoutUrl, keycloakSession, refreshKeycloakToken, rolesFromAccessToken, type RoleToken } from "../lib/keycloakSession"

const now = 2_000_000
const config = { issuer: "http://keycloak:8080/realms/inout", clientId: "inout-frontend", clientSecret: "test-secret" }
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
  assert.equal("refresh_token" in keycloakSession(session, expired, true), false)
})

test("malformed role claims never grant access", () => {
  for (const value of [null, "malformed", accessToken("admin"), accessToken(null)]) assert.deepEqual(rolesFromAccessToken(value), [])
  assert.deepEqual(rolesFromAccessToken(accessToken(["operator", 1])), ["operator"])
})

test("SSO logout uses the public realm and a fixed local return path", () => {
  const url = new URL(keycloakLogoutUrl("https://identity.test/realms/inout/", "inout-frontend", "https://app.test"))
  assert.equal(url.origin, "https://identity.test")
  assert.equal(url.pathname, "/realms/inout/protocol/openid-connect/logout")
  assert.equal(url.searchParams.get("client_id"), "inout-frontend")
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), "https://app.test/login")
  assert.equal(url.searchParams.has("refresh_token"), false)
})
