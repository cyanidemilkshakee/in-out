import assert from "node:assert/strict"
import { test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { authenticateKeycloakCredentials, KeycloakCredentialsError, revokeKeycloakRefreshToken } from "../lib/keycloakCredentials"
import { verifyKeycloakToken, type KeycloakTokenConfig } from "../lib/keycloakTokenValidation"

const config = { issuer: "https://identity.test/realms/inout", jwksIssuer: "http://identity.internal/realms/inout", clientId: "inout-frontend", clientSecret: "synthetic-client-secret" }
const inputs = { username: " test-admin ", password: "synthetic-password" }
const pair = generateKeyPair("RS256")
async function tokenResponse(accessClaims: Record<string, unknown> = {}, idClaims: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await pair
  const now = Math.floor(Date.now() / 1000)
  const base = { sub: "admin-a", iss: config.issuer, aud: config.clientId, azp: config.clientId, iat: now, exp: now + 300 }
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(privateKey)
  const access_token = await sign({ ...base, typ: "Bearer", realm_access: { roles: ["admin"] }, ...accessClaims })
  const id_token = await sign({ ...base, typ: "ID", name: "Test Admin", email: "admin@example.test", ...idClaims })
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" }] })
  return {
    tokens: { access_token, id_token, refresh_token: "synthetic-refresh", expires_in: 300, token_type: "Bearer" },
    verify: (value: unknown, options: KeycloakTokenConfig, kind: "access" | "id", sub?: string) => verifyKeycloakToken(value, options, kind, sub, keys),
  }
}

test("own-form credentials go only to the configured provider and return verified identity", async () => {
  const fixture = await tokenResponse()
  let calls = 0
  const identity = await authenticateKeycloakCredentials({ ...inputs, otp: "123456" }, config, async (url, init) => {
    calls++
    assert.equal(url, `${config.jwksIssuer}/protocol/openid-connect/token`)
    assert.equal(init?.redirect, "error")
    assert.equal(init?.cache, "no-store")
    assert.ok(init?.signal)
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get("username"), "test-admin")
    assert.equal(body.get("password"), inputs.password)
    assert.equal(body.get("client_secret"), config.clientSecret)
    assert.equal(body.get("grant_type"), "password")
    assert.equal(body.get("totp"), "123456")
    return Response.json(fixture.tokens)
  }, fixture.verify)
  assert.equal(calls, 1)
  assert.equal(identity.id, "admin-a")
  assert.deepEqual(identity.roles, ["admin"])
  assert.equal(identity.refreshToken, "synthetic-refresh")
  assert.ok(identity.authTime <= Date.now() / 1000)
  assert.ok(!("password" in identity))
})

test("malformed credentials never reach the provider", async () => {
  for (const invalid of [{ username: "" }, { username: "x".repeat(255) }, { username: "name\n" }, { username: ["admin"] },
    { password: "" }, { password: "x".repeat(129) }, { password: 123 }, { otp: "123" }, { otp: 123456 }, { otp: "12abc456" }]) {
    await assert.rejects(authenticateKeycloakCredentials({ ...inputs, ...invalid }, config, async () => { throw new Error("Unexpected call") }),
      (error: unknown) => error instanceof KeycloakCredentialsError && error.code === "credentials")
  }
})

test("invalid, disabled and unknown accounts have the same error and password requests are not retried", async () => {
  for (const error of [{ error: "invalid_grant", error_description: "Invalid user credentials" },
    { error: "invalid_grant", error_description: "Account disabled" }]) {
    let calls = 0
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => { calls++; return Response.json(error, { status: 401 }) }),
      (failure: unknown) => failure instanceof KeycloakCredentialsError && failure.code === "credentials" && !failure.message.includes(error.error_description))
    assert.equal(calls, 1)
  }
  for (const status of [429, 500, 503]) {
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => Response.json({ private: "secret" }, { status })),
      (failure: unknown) => failure instanceof KeycloakCredentialsError && failure.code === "service_unavailable" && !failure.message.includes("secret"))
  }
  await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => Response.json({ error: "invalid_grant", error_description: "Account is not fully set up" }, { status: 400 })),
    (failure: unknown) => failure instanceof KeycloakCredentialsError && failure.code === "account_setup_required")
})

test("signed direct-grant identity cannot mix accounts, replay stale logins or claim conflicting auth times", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const [access, identity] of [[{}, { sub: "admin-b" }], [{ aud: "other-client" }, {}],
    [{ iat: now - 60 }, {}], [{}, { iat: now - 60 }], [{ auth_time: now - 60 }, {}],
    [{ auth_time: now }, { auth_time: now - 1 }]]) {
    const fixture = await tokenResponse(access, identity)
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => Response.json(fixture.tokens), fixture.verify),
      (failure: unknown) => failure instanceof KeycloakCredentialsError && failure.code === "service_unavailable")
  }
  const fixture = await tokenResponse({ auth_time: now }, { auth_time: now })
  const identity = await authenticateKeycloakCredentials(inputs, config, async () => Response.json(fixture.tokens), fixture.verify)
  assert.equal(identity.authTime, now)
})

test("direct grants reject substituted ID tokens and mixed sessions from the same account", async () => {
  for (const [access, identity] of [[{}, { typ: "Bearer" }], [{ sid: "login-a" }, { sid: "login-b" }],
    [{ session_state: "login-a" }, { sid: "login-b" }], [{}, { at_hash: "a".repeat(22) }]]) {
    const fixture = await tokenResponse(access, identity)
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => Response.json(fixture.tokens), fixture.verify),
      (failure: unknown) => failure instanceof KeycloakCredentialsError && failure.code === "service_unavailable")
  }
  const fixture = await tokenResponse({ sid: "login-a" }, { sid: "login-a" })
  assert.equal((await authenticateKeycloakCredentials(inputs, config, async () => Response.json(fixture.tokens), fixture.verify)).id, "admin-a")
})

test("invalid token shapes, oversized responses and redirects cannot create a session", async () => {
  const fixture = await tokenResponse()
  for (const overrides of [{ access_token: "forged.payload.signature" }, { id_token: "invalid" },
    { token_type: "Basic" }, { refresh_token: "" }, { expires_in: -1 }, { expires_in: 300.5 }, { expires_in: 86401 }]) {
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => Response.json({ ...fixture.tokens, ...overrides }), fixture.verify))
  }
  for (const response of [new Response("", { status: 302, headers: { Location: "https://attacker.test" } }), new Response("x".repeat(129 * 1024))]) {
    await assert.rejects(authenticateKeycloakCredentials(inputs, config, async () => response, fixture.verify))
  }
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
