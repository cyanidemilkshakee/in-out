import assert from "node:assert/strict"
import { test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { boundedIdentityResponse, verifyKeycloakToken, verifyKeycloakTokenPair } from "../lib/keycloakTokenValidation"

const config = { issuer: "https://identity.test/realms/inout", clientId: "inout-frontend" }
const pair = generateKeyPair("RS256")
async function fixture(overrides: Record<string, unknown> = {}, kind = "access") {
  const { privateKey, publicKey } = await pair
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ sub: "admin-a", iss: config.issuer, aud: config.clientId, azp: config.clientId,
    typ: kind === "access" ? "Bearer" : "ID", iat: now, exp: now + 300, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(privateKey)
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" }] })
  return { token, keys }
}

test("access and ID signatures match the fixed issuer, audience and account", async () => {
  for (const kind of ["access", "id"] as const) {
    const { token, keys } = await fixture({}, kind)
    const claims = await verifyKeycloakToken(token, config, kind, "admin-a", keys)
    assert.equal(claims.sub, "admin-a")
    await assert.rejects(verifyKeycloakToken(token, config, kind, "admin-b", keys))
    const [header, payload, signature] = token.split(".")
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "admin-b" })).toString("base64url")}.${signature}`
    await assert.rejects(verifyKeycloakToken(forged, config, kind, "admin-b", keys))
  }
})

test("wrong issuer/audience/client, expired, missing and malformed token claims fail closed", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const claims of [{ iss: "https://wrong.test" }, { aud: "other-client" }, { azp: "other-client" },
    { exp: now - 60 }, { sub: "" }, { sub: undefined }, { iat: undefined }, { exp: undefined },
    { typ: "ID" }, { iat: now + 60 }, { iat: 1.5 }, { exp: now + 300.5 },
    { auth_time: "today" }, { auth_time: -1 }, { auth_time: 1.5 }, { auth_time: now + 60 },
    { iat: now - 60, auth_time: now }, { exp: now + 10, iat: now + 20 },
    { aud: [config.clientId, 123] }, { sid: "" }, { session_state: 123 }]) {
    const { token, keys } = await fixture(claims)
    await assert.rejects(verifyKeycloakToken(token, config, "access", "admin-a", keys))
  }
  const { keys } = await fixture()
  for (const token of [null, "invalid", "x".repeat(32 * 1024 + 1)]) {
    await assert.rejects(verifyKeycloakToken(token, config, "access", "admin-a", keys))
  }
})

test("ID verification rejects access/refresh tokens and ambiguous authorized parties", async () => {
  for (const overrides of [{ typ: "Bearer" }, { typ: "Refresh" }, { typ: undefined },
    { aud: [config.clientId, "another-client"], azp: undefined }]) {
    const { token, keys } = await fixture(overrides, "id")
    await assert.rejects(verifyKeycloakToken(token, config, "id", "admin-a", keys))
  }
  const { token, keys } = await fixture({ aud: [config.clientId, "another-client"] }, "id")
  await verifyKeycloakToken(token, config, "id", "admin-a", keys)
})

test("signed same-account tokens must describe the same session and access-token hash", async () => {
  const { token: accessToken, keys } = await fixture({ sid: "visit-a" })
  const access = await verifyKeycloakToken(accessToken, config, "access", "admin-a", keys)
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))).subarray(0, 16).toString("base64url")
  for (const claim of [{ sid: "visit-b" }, { session_state: "visit-b" }, { at_hash: "a".repeat(22) },
    { at_hash: null }, { at_hash: hash + "=" }, { at_hash: 123 }]) {
    const identityFixture = await fixture(claim, "id")
    const identity = await verifyKeycloakToken(identityFixture.token, config, "id", "admin-a", keys)
    await assert.rejects(verifyKeycloakTokenPair(accessToken, access, identity))
  }
  const { token } = await fixture({ sid: "visit-a", at_hash: hash }, "id")
  await verifyKeycloakTokenPair(accessToken, access, await verifyKeycloakToken(token, config, "id", "admin-a", keys))
  // Hash/session claims are optional in OIDC; valid provider configurations
  // without them still work after independent signature and account checks.
  const minimal = await fixture({}, "id")
  await verifyKeycloakTokenPair(accessToken, access, await verifyKeycloakToken(minimal.token, config, "id", "admin-a", keys))
})

test("unsigned and attacker-signed tokens cannot grant a session", async () => {
  const { token, keys } = await fixture()
  const [header, payload] = token.split(".")
  await assert.rejects(verifyKeycloakToken(`${header}.${payload}.`, config, "access", undefined, keys))
  const attacker = await generateKeyPair("RS256")
  const forged = await new SignJWT(JSON.parse(Buffer.from(payload, "base64url").toString()))
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(attacker.privateKey)
  await assert.rejects(verifyKeycloakToken(forged, config, "access", undefined, keys))
})

test("provider responses have bounded bytes and cannot redirect credentials", async () => {
  for (const response of [new Response("x", { status: 302, headers: { Location: "https://wrong.test" } }),
    new Response("x", { headers: { "Content-Length": "999999" } }), new Response("x".repeat(129 * 1024))]) {
    await assert.rejects(boundedIdentityResponse(response))
  }
  const response = await boundedIdentityResponse(Response.json({ access_token: "synthetic" }))
  assert.deepEqual(await response.json(), { access_token: "synthetic" })
})

test("rejected provider responses cancel unread streams without waiting for cancellation", async () => {
  for (const options of [{ status: 302 }, { headers: { "Content-Length": "999999" } },
    { headers: { "Content-Length": "invalid" } }, { headers: { "Content-Length": "" } }]) {
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; return new Promise(() => {}) } })
    await assert.rejects(boundedIdentityResponse(new Response(stream, options)))
    assert.equal(canceled, true)
  }
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(129 * 1024)) },
    cancel() { canceled = true },
  })
  await assert.rejects(boundedIdentityResponse(new Response(stream)))
  assert.equal(canceled, true)
  assert.equal((await boundedIdentityResponse(new Response(null, { status: 204 }))).status, 204)
})
