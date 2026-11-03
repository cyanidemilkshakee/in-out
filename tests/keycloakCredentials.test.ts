import assert from "node:assert/strict"
import { test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { authenticateKeycloakCredentials, KeycloakCredentialsError, revokeKeycloakRefreshToken } from "../lib/keycloakCredentials"
import { interactionChallenge } from "../lib/keycloakInteractions"
import { verifyKeycloakToken, type KeycloakTokenConfig } from "../lib/keycloakTokenValidation"

const config = { issuer: "https://identity.test/realms/inout", jwksIssuer: "http://identity.internal/realms/inout", clientId: "inout-frontend", clientSecret: "synthetic-client-secret" }
const inputs = { username: " test-admin ", password: "synthetic-password" }
const pair = generateKeyPair("RS256")
const failure = (code: string) => (error: unknown) => error instanceof KeycloakCredentialsError && error.code === code
async function tokenResponse(accessClaims: Record<string, unknown> = {}, idClaims: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await pair
  const now = Math.floor(Date.now() / 1000)
  const base = { sub: "admin-a", iss: config.issuer, aud: config.clientId, azp: config.clientId, iat: now, exp: now + 300, auth_time: now }
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(privateKey)
  const access_token = await sign({ ...base, typ: "Bearer", realm_access: { roles: ["zone-admin"] }, ...accessClaims })
  const id_token = await sign({ ...base, typ: "ID", name: "Test Admin", email: "admin@example.test", ...idClaims })
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" }] })
  return {
    tokens: { access_token, id_token, refresh_token: "synthetic-refresh", expires_in: 300, token_type: "Bearer" },
    verify: (value: unknown, options: KeycloakTokenConfig, kind: "access" | "id", sub?: string) => verifyKeycloakToken(value, options, kind, sub, keys),
  }
}

function provider(tokens: unknown, { proof, tokenStatus = 200, subject = "admin-a" }: { proof?: Response; tokenStatus?: number; subject?: string } = {}) {
  let challenge: string | undefined
  let used = false
  const calls: string[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url)
    calls.push(path)
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("Authorization"), "Basic " + btoa(`${config.clientId}:${config.clientSecret}`))
    assert.equal(headers.get("Content-Type"), "application/json")
    const body = JSON.parse(String(init?.body))
    assert.ok(!Object.hasOwn(body, "client_secret"))
    assert.ok(!Object.hasOwn(body, "grant_type"))
    if (path === `${config.jwksIssuer}/inout-auth/verify`) {
      assert.equal(body.mode, "login")
      assert.equal(body.username, "test-admin")
      assert.equal(body.currentPassword, inputs.password)
      assert.match(body.codeChallenge, /^[A-Za-z0-9_-]{43}$/)
      assert.ok(!Object.hasOwn(body, "codeVerifier"))
      challenge = body.codeChallenge
      if (proof) return proof.clone()
      return Response.json({ code: "c".repeat(43), expiresIn: 30, subject })
    }
    assert.equal(path, `${config.jwksIssuer}/inout-auth/token`, "Only the custom endpoints may receive sign-in requests")
    assert.equal(body.code, "c".repeat(43))
    assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(await interactionChallenge(body.codeVerifier), challenge)
    assert.ok(!Object.hasOwn(body, "currentPassword"))
    assert.equal(used, false, "Codes may only be redeemed once")
    used = true
    return Response.json(tokens, { status: tokenStatus })
  }
  return { fetcher, calls }
}

test("app credentials use authenticated custom proof then one-use S256 code redemption", async () => {
  const fixture = await tokenResponse()
  const upstream = provider(fixture.tokens)
  const identity = await authenticateKeycloakCredentials({ ...inputs, otp: "123456" }, config, async (url, init) => {
    if (String(url).endsWith("/verify")) assert.equal(JSON.parse(String(init?.body)).otp, "123456")
    return upstream.fetcher(url, init)
  }, fixture.verify)
  assert.equal(upstream.calls.length, 2)
  assert.equal(identity.id, "admin-a")
  assert.deepEqual(identity.roles, ["zone-admin"])
  assert.equal(identity.refreshToken, "synthetic-refresh")
  assert.ok(identity.authTime <= Date.now() / 1000)
  assert.ok(!("password" in identity))
})

test("malformed credentials never reach the provider", async () => {
  for (const invalid of [{ username: "" }, { username: "x".repeat(255) }, { username: "name\n" }, { username: ["admin"] },
    { password: "" }, { password: "x".repeat(129) }, { password: 123 }, { otp: "123" }, { otp: 123456 }, { otp: "12abc456" }]) {
    await assert.rejects(authenticateKeycloakCredentials({ ...inputs, ...invalid }, config, async () => { throw new Error("Unexpected call") }), failure("credentials"))
  }
})

test("bad proofs remain generic and neither password verification nor failed code redemption retries", async () => {
  const fixture = await tokenResponse()
  const rejected = provider(fixture.tokens, { proof: Response.json({ error: "credentials", detail: "synthetic-private-detail" }, { status: 401 }) })
  await assert.rejects(authenticateKeycloakCredentials(inputs, config, rejected.fetcher, fixture.verify), failure("credentials"))
  assert.equal(rejected.calls.length, 1)
  for (const status of [400, 401, 409, 429, 500, 503]) {
    const upstream = provider({ error: "invalid_code" }, { tokenStatus: status })
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, upstream.fetcher, fixture.verify), failure("service_unavailable"))
    assert.equal(upstream.calls.length, 2)
  }
})

test("only explicit post-proof setup status opens the setup UI; old password-grant errors are not evidence", async () => {
  const fixture = await tokenResponse()
  for (const [body, status, expected] of [
    [{ error: "account_setup_required" }, 409, "account_setup_required"],
    [{ error: "account_setup_required" }, 401, "service_unavailable"],
    [{ error: "invalid_grant", error_description: "Account is not fully set up" }, 400, "service_unavailable"],
    [{ error: "invalid_client" }, 401, "service_unavailable"],
    [{ private: "secret" }, 429, "service_unavailable"],
    [{ private: "secret" }, 503, "service_unavailable"],
  ] as const) {
    const upstream = provider(fixture.tokens, { proof: Response.json(body, { status }) })
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, upstream.fetcher, fixture.verify), failure(expected))
    assert.equal(upstream.calls.length, 1)
  }
})

test("signed interaction tokens must match pinned account, audience and fresh authentication time", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const [access, identity] of [[{}, { sub: "admin-b" }], [{ aud: "other-client" }, {}],
    [{ iat: now - 60 }, {}], [{}, { iat: now - 60 }], [{ auth_time: now - 60 }, {}],
    [{ auth_time: now }, { auth_time: now - 1 }], [{ auth_time: undefined }, { auth_time: undefined }]]) {
    const fixture = await tokenResponse(access, identity)
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, provider(fixture.tokens).fetcher, fixture.verify), failure("service_unavailable"))
  }
  const fixture = await tokenResponse()
  await assert.rejects(authenticateKeycloakCredentials(inputs, config, provider(fixture.tokens, { subject: "admin-b" }).fetcher, fixture.verify), failure("service_unavailable"))
  const authTime = (await authenticateKeycloakCredentials(inputs, config, provider(fixture.tokens).fetcher, fixture.verify)).authTime
  assert.ok(authTime >= now && authTime <= Math.floor(Date.now() / 1000))
})

test("interaction exchange rejects substituted ID tokens and mixed sessions from the same account", async () => {
  for (const [access, identity] of [[{}, { typ: "Bearer" }], [{ sid: "login-a" }, { sid: "login-b" }],
    [{ session_state: "login-a" }, { sid: "login-b" }], [{}, { at_hash: "a".repeat(22) }]]) {
    const fixture = await tokenResponse(access, identity)
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, provider(fixture.tokens).fetcher, fixture.verify), failure("service_unavailable"))
  }
  const fixture = await tokenResponse({ sid: "login-a" }, { sid: "login-a" })
  assert.equal((await authenticateKeycloakCredentials(inputs, config, provider(fixture.tokens).fetcher, fixture.verify)).id, "admin-a")
})

test("invalid interaction responses cannot send an arbitrary code to the exchange endpoint", async () => {
  const fixture = await tokenResponse()
  for (const patch of [{ code: "short" }, { code: "../token" }, { expiresIn: 0 }, { expiresIn: 300 }, { expiresIn: "30" }, { subject: "" }, { subject: "bad\nsubject" }]) {
    const upstream = provider(fixture.tokens, { proof: Response.json({ code: "c".repeat(43), expiresIn: 30, subject: "admin-a", ...patch }) })
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, upstream.fetcher, fixture.verify), failure("service_unavailable"))
    assert.equal(upstream.calls.length, 1)
  }
})

test("invalid tokens, oversized proof replies and redirects cannot create a session", async () => {
  const fixture = await tokenResponse()
  for (const overrides of [{ access_token: "forged.payload.signature" }, { id_token: "invalid" },
    { token_type: "Basic" }, { refresh_token: "" }, { expires_in: -1 }, { expires_in: 300.5 }, { expires_in: 86401 }]) {
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, provider({ ...fixture.tokens, ...overrides }).fetcher, fixture.verify))
  }
  for (const response of [new Response("", { status: 302, headers: { Location: "https://attacker.test" } }), new Response("x".repeat(129 * 1024))]) {
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => response, fixture.verify), failure("service_unavailable"))
  }
})

test("authentication never falls back to a legacy grant if the extension is absent", async () => {
  let calls = 0
  await assert.rejects(authenticateKeycloakCredentials(inputs, config, async (url) => {
    calls++
    assert.equal(String(url), `${config.jwksIssuer}/inout-auth/verify`)
    return Response.json({ error: "not_found" }, { status: 404 })
  }), failure("service_unavailable"))
  assert.equal(calls, 1)
})

test("own-form logout revokes only its refresh session at the fixed provider endpoint", async () => {
  let calls = 0
  await revokeKeycloakRefreshToken("synthetic-refresh", config, async (url, init) => {
    calls++
    assert.equal(url, `${config.jwksIssuer}/protocol/openid-connect/revoke`)
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get("token"), "synthetic-refresh")
    assert.equal(body.get("token_type_hint"), "refresh_token")
    assert.equal(body.get("client_secret"), config.clientSecret)
    return new Response(null, { status: 200 })
  })
  assert.equal(calls, 1)
  await assert.rejects(revokeKeycloakRefreshToken("synthetic-refresh", config, async () => new Response(null, { status: 503 })))
})
