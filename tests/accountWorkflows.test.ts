import assert from "node:assert/strict";
import { test } from "node:test";
import { listManagedUsers, updateManagedUser, type ManagedUser } from "../services/keycloakUserService";
import { identityCommandTimeoutMs } from "../lib/identityRequestPolicy";

const user = (id: number): ManagedUser => ({ id: String(id), username: `user-${id}`, firstName: "", lastName: "",
  email: "", enabled: id % 2 === 0, emailVerified: false, roles: ["operator"], checkpointId: "cp-main", canManage: true });

test("directory loads every provider page and forwards the same encoded search", async () => {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://app.invalid");
    calls.push(url);
    const first = Number(url.searchParams.get("first"));
    const items = Array.from({ length: Math.min(100, 237 - first) }, (_, index) => user(first + index));
    return Response.json({ data: { items, first, max: 100 } });
  };
  try {
    const result = await listManagedUsers("  A&B / Jane  ");
    assert.equal(result.items.length, 237);
    assert.equal(result.items.at(-1)?.id, "236");
    assert.deepEqual(calls.map(url => url.searchParams.get("first")), ["0", "100", "200"]);
    assert.ok(calls.every(url => url.searchParams.get("search") === "A&B / Jane" && url.searchParams.get("max") === "100"));
    assert.equal(result.items.filter(item => !item.enabled).length, 118);
  } finally { globalThis.fetch = original; }
});

test("directory terminates an exact full page with an empty next page", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => Response.json({ data: { items: calls++ === 0 ? Array.from({ length: 100 }, (_, index) => user(index)) : [] } });
  try { assert.equal((await listManagedUsers()).items.length, 100); assert.equal(calls, 2); }
  finally { globalThis.fetch = original; }
});

test("failed later pages and ignored offsets never masquerade as a complete directory", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ data: { items: Array.from({ length: 100 }, (_, index) => user(index)) } })
    : Response.json({ error: "Identity service is unavailable" }, { status: 503 });
  try {
    await assert.rejects(listManagedUsers(), /Identity service is unavailable/);
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ data: { items: Array.from({ length: 100 }, (_, index) => user(index)) } }); };
    await assert.rejects(listManagedUsers(), /complete user directory/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("combined Save sends profile, roles and checkpoint in one command and trusts the returned state", async () => {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  const actual = { ...user(5), firstName: "Saved", roles: ["admin"] as const, checkpointId: null };
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/keycloak");
    assert.equal(options?.method, "POST");
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ data: actual });
  };
  try {
    const input = { firstName: "Saved", email: "new@example.invalid", enabled: false, roles: ["admin"], checkpointId: null };
    assert.deepEqual(await updateManagedUser("5", input), actual);
    assert.deepEqual(calls, [{ action: "updateUser", userId: "5", input }]);
  } finally { globalThis.fetch = original; }
});

test("compound identity writes have a bounded compensation budget while other calls remain short", () => {
  for (const action of ["createUser", "updateUser", "setRoles"]) assert.equal(identityCommandTimeoutMs(action), 180_000);
  for (const action of ["resetPassword", "endSessions", "listUsers", ""]) assert.equal(identityCommandTimeoutMs(action), 15_000);
});
