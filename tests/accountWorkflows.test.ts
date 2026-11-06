import assert from "node:assert/strict";
import { test } from "node:test";
import { listManagedUserPage, listManagedUsers, updateManagedUser, type ManagedUser } from "../services/keycloakUserService";
import { readPendingPermissions, readPermissionDirectory } from "../services/permissionReadService";
import { identityCommandTimeoutMs } from "../lib/identityRequestPolicy";

const user = (id: number): ManagedUser => ({ id: String(id), username: `user-${id}`, firstName: "", lastName: "",
  email: "", enabled: id % 2 === 0, emailVerified: false, roles: ["operator"], checkpointId: "cp-main", canManage: true });

test("one account page stays bounded and empty scoped pages retain the provider continuation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls++;
    const url = new URL(String(input), "https://app.invalid");
    assert.equal(url.searchParams.get("first"), "25");
    assert.equal(url.searchParams.get("max"), "25");
    assert.equal(url.searchParams.get("search"), "A&B / Jane");
    assert.equal(options?.signal, controller.signal);
    return Response.json({ data: { items: [], first: 25, max: 25, hasMore: true, nextFirst: 50 } });
  };
  try {
    const page = await listManagedUserPage(" A&B / Jane ", 25, controller.signal);
    assert.equal(calls, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextFirst, 50);
    globalThis.fetch = async () => Response.json({ data: { items: [], first: 25, max: 25, hasMore: true, nextFirst: 25 } });
    await assert.rejects(listManagedUserPage("", 25), /invalid directory page/);
  } finally { globalThis.fetch = original; }
});

test("permission reads keep independent bounds, filters, exact links, and cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const calls: URL[] = [];
  globalThis.fetch = async (input, options) => {
    calls.push(new URL(String(input), "https://app.invalid"));
    assert.equal(options?.signal, controller.signal);
    return Response.json({ data: { items: [], total: 0, limit: 25, offset: 50 } });
  };
  try {
    await readPermissionDirectory({ limit: 25, offset: 50, state: "restricted", search: "A&B", subjectId: "subject/1" }, controller.signal);
    await readPendingPermissions({ limit: 1, offset: 0, typeGroup: "manual", requestId: "request/1" }, controller.signal);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.get("search"), "A&B");
    assert.equal(calls[0].searchParams.get("subjectId"), "subject/1");
    assert.equal(calls[0].searchParams.get("state"), "restricted");
    assert.equal(calls[0].searchParams.get("offset"), "50");
    assert.equal(calls[1].searchParams.get("limit"), "1");
    assert.equal(calls[1].searchParams.get("requestId"), "request/1");
    assert.equal(calls[1].searchParams.get("typeGroup"), "manual");
  } finally { globalThis.fetch = original; }
});

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
  const actual = { ...user(5), firstName: "Saved", roles: ["zone-admin"] as const, checkpointId: null };
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/keycloak");
    assert.equal(options?.method, "POST");
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ data: actual });
  };
  try {
    const input = { firstName: "Saved", email: "new@example.invalid", enabled: false, roles: ["zone-admin"], checkpointId: null };
    assert.deepEqual(await updateManagedUser("5", input), actual);
    assert.deepEqual(calls, [{ action: "updateUser", userId: "5", input }]);
  } finally { globalThis.fetch = original; }
});

test("compound identity writes have a bounded compensation budget while other calls remain short", () => {
  for (const action of ["createUser", "updateUser", "setRoles"]) assert.equal(identityCommandTimeoutMs(action), 180_000);
  for (const action of ["resetPassword", "endSessions", "listUsers", ""]) assert.equal(identityCommandTimeoutMs(action), 15_000);
});
