import assert from "node:assert/strict"
import { test } from "node:test"
import { updateKeycloakPassword, PasswordUpdateError, type PasswordUpdateInput, type KeycloakPasswordUpdateOptions } from "../lib/keycloakPasswordUpdate"

const config = { issuer: "https://identity.fixture/realms/inout", jwksIssuer: "http://identity.internal/realms/inout",
  clientId: "inout-frontend", clientSecret: "synthetic-app-secret" }
const input: PasswordUpdateInput = { mode: "setup", username: " Alice@Example.test ", currentPassword: "synthetic-current", newPassword: "synthetic-new", otp: "123456" }
const failure = (code: string) => (error: unknown) => error instanceof PasswordUpdateError && error.code === code

function fixture() {
  const state = {
    calls: [] as Array<{ action: string; body: Record<string, unknown> }>, events: [] as string[],
    prepared: { subject: "user-1" } as unknown,
    prepareStatus: 200, prepareError: false,
    result: { ok: true, subject: "user-1" } as unknown,
    status: 200, dropResponse: false, locked: false,
    locks: [] as string[], writes: 0,
  }
  const options: KeycloakPasswordUpdateOptions = {
    fetcher: async (url, init) => {
      assert.equal(init?.cache, "no-store")
      assert.equal(init?.redirect, "error")
      assert.ok(init?.signal)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get("Authorization"), "Basic " + btoa(`${config.clientId}:${config.clientSecret}`))
      assert.equal(headers.get("Content-Type"), "application/json")
      const action = String(url).slice(config.jwksIssuer.length)
      const body = JSON.parse(String(init?.body))
      state.calls.push({ action, body })
      if (action === "/inout-auth/prepare") {
        assert.equal(body.username, input.username.trim())
        assert.ok(!Object.hasOwn(body, "currentPassword"), "Preparation does not receive credentials")
        state.events.push("prepare")
        if (state.prepareError) throw new Error("synthetic-private-provider-detail")
        return Response.json(state.prepared, { status: state.prepareStatus })
      }
      assert.equal(action, "/inout-auth/verify", "No password grant, admin API or service token request is permitted")
      assert.equal(state.locked, true)
      assert.equal(body.expectedSubject, "user-1")
      assert.equal(body.username, input.username.trim())
      assert.equal(body.currentPassword, input.currentPassword)
      assert.equal(body.newPassword, input.newPassword)
      assert.equal(body.otp, input.otp)
      assert.ok(["setup", "change"].includes(body.mode))
      assert.ok(!Object.hasOwn(body, "client_secret"))
      assert.ok(!Object.hasOwn(body, "grant_type"))
      state.events.push("verify-and-update")
      state.writes++
      if (state.dropResponse) throw new Error("synthetic-private-provider-detail")
      return Response.json(state.result, { status: state.status })
    },
    withUserLock: async (subject, operation) => {
      state.locks.push(subject)
      state.events.push("lock")
      state.locked = true
      try { return await operation() } finally { state.locked = false }
    },
  }
  return { state, options, run: (overrides: Partial<PasswordUpdateInput> = {}) => updateKeycloakPassword({ ...input, ...overrides }, config, options) }
}

test("temporary setup pins the canonical subject before a leased transactional provider update", async () => {
  const { state, run } = fixture()
  assert.deepEqual(await run(), { subject: "user-1" })
  assert.deepEqual(state.events, ["prepare", "lock", "verify-and-update"])
  assert.deepEqual(state.locks, ["user-1"])
  assert.equal(state.writes, 1)
  assert.equal(state.calls.length, 2)
  assert.equal(state.calls[1].body.mode, "setup")
})

test("normal changes bind both preparation and mutation to the signed-in subject", async () => {
  const { state, run } = fixture()
  assert.deepEqual(await run({ mode: "change", expectedSubject: "user-1" }), { subject: "user-1" })
  assert.equal(state.calls[0].body.expectedSubject, "user-1")
  assert.equal(state.calls[1].body.expectedSubject, "user-1")
  assert.equal(state.calls[1].body.mode, "change")
})

test("invalid input and absent locks are rejected before sending credentials", async () => {
  for (const invalid of [{ currentPassword: "" }, { newPassword: input.currentPassword }, { newPassword: " " },
    { newPassword: "x".repeat(129) }, { username: "name\n" }, { otp: "123" }, { mode: "unrecognized" }]) {
    const { state, run } = fixture()
    await assert.rejects(run(invalid as Partial<PasswordUpdateInput>), failure("invalid_request"))
    assert.equal(state.calls.length, 0)
  }
  const { state, options } = fixture()
  await assert.rejects(updateKeycloakPassword(input, config, { ...options, withUserLock: undefined } as any), failure("service_unavailable"))
  assert.equal(state.calls.length, 0)
  await assert.rejects(updateKeycloakPassword({ ...input, mode: "change" }, config, options), failure("credentials"))
  assert.equal(state.calls.length, 0)
})

test("a prepared identity cannot retarget the signed-in account before mutation", async () => {
  const { state, run } = fixture()
  state.prepared = { subject: "other-user" }
  await assert.rejects(run({ mode: "change", expectedSubject: "user-1" }), failure("credentials"))
  assert.equal(state.writes, 0)
  assert.deepEqual(state.locks, [])
})

test("bad credential and ineligible responses remain generic without a second provider write", async () => {
  for (const code of ["credentials", "not_ready", "account_setup_required"]) {
    const { state, run } = fixture()
    state.status = code === "credentials" ? 401 : 409
    state.result = { error: code, detail: "synthetic-private-provider-detail" }
    await assert.rejects(run(), (error: unknown) => failure("credentials")(error) && error instanceof Error && !error.message.includes("synthetic"))
    assert.equal(state.writes, 1)
  }
})

test("password policy and account-state errors are safe explicit failures", async () => {
  for (const [status, code] of [[422, "password_policy"], [409, "state_changed"]] as const) {
    const { state, run } = fixture()
    state.status = status
    state.result = { error: code, detail: "synthetic-private-provider-detail" }
    await assert.rejects(run(), failure(code))
    assert.equal(state.writes, 1)
  }
})

test("ambiguous provider writes return unconfirmed without retry or credential rollback", async () => {
  for (const configure of [
    (state: ReturnType<typeof fixture>["state"]) => { state.dropResponse = true },
    (state: ReturnType<typeof fixture>["state"]) => { state.status = 500 },
    (state: ReturnType<typeof fixture>["state"]) => { state.status = 503 },
    (state: ReturnType<typeof fixture>["state"]) => { state.result = { ok: false } },
    (state: ReturnType<typeof fixture>["state"]) => { state.result = { ok: true, subject: "other-user" } },
  ]) {
    const { state, run } = fixture()
    configure(state)
    await assert.rejects(run(), failure("update_unconfirmed"))
    assert.equal(state.writes, 1)
    assert.equal(state.calls.length, 2)
  }
})

test("preparation outages and malformed subjects cannot reach the mutation endpoint", async () => {
  for (const configure of [
    (state: ReturnType<typeof fixture>["state"]) => { state.prepareError = true },
    (state: ReturnType<typeof fixture>["state"]) => { state.prepareStatus = 503 },
    (state: ReturnType<typeof fixture>["state"]) => { state.prepared = { subject: "" } },
    (state: ReturnType<typeof fixture>["state"]) => { state.prepared = { subject: "bad\nsubject" } },
  ]) {
    const { state, run } = fixture()
    configure(state)
    await assert.rejects(run(), failure("service_unavailable"))
    assert.equal(state.writes, 0)
    assert.deepEqual(state.locks, [])
  }
})

test("lease errors propagate and stop mutation even after successful target preparation", async () => {
  const { state, options } = fixture()
  await assert.rejects(updateKeycloakPassword(input, config, { ...options, withUserLock: async () => {
    throw new PasswordUpdateError("state_changed", 409, "A password update is already in progress.")
  } }), failure("state_changed"))
  assert.equal(state.writes, 0)
})

test("password updates use only the frontend client configuration", async () => {
  const { options, state } = fixture()
  await updateKeycloakPassword(input, config, options)
  assert.equal(state.calls.length, 2)
  assert.ok(state.calls.every(call => call.action.startsWith("/inout-auth/")))
})

test("the extension being absent fails closed without administrative or password-grant fallback", async () => {
  let calls = 0
  await assert.rejects(updateKeycloakPassword(input, config, { withUserLock: async (_subject, action) => action(), fetcher: async (url) => {
    calls++
    assert.equal(String(url), `${config.jwksIssuer}/inout-auth/prepare`)
    return Response.json({ error: "not_found" }, { status: 404 })
  } }), failure("service_unavailable"))
  assert.equal(calls, 1)
})
