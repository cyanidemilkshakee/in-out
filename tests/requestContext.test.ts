import assert from "node:assert/strict";
import { test } from "node:test";
import { currentRequestId, normalizedRequestId, upstreamRoute, withRequestContext } from "../lib/requestContext";

const first = "357cd693-78c1-4362-b185-ef1d82bc7674";
const second = "44735e94-a14f-463e-87c0-f91b1ac77b88";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("only bounded canonical UUID correlation values survive normalization", () => {
  assert.equal(normalizedRequestId(first.toUpperCase()), first);
  for (const value of [undefined, null, "", "x".repeat(10000), first + "\r\nInjected: secret", "Bearer secret", " " + first]) {
    const result = normalizedRequestId(value);
    assert.match(result, uuid);
    assert.notEqual(result, value);
  }
});

test("concurrent asynchronous work retains its own correlation and restores the caller", async () => {
  assert.equal(currentRequestId(), undefined);
  await Promise.all([first, second].map(id => withRequestContext(id, async () => {
    await new Promise(resolve => setTimeout(resolve, id === first ? 5 : 1));
    assert.equal(currentRequestId(), id);
    await withRequestContext(null, async () => {
      await Promise.resolve();
      assert.notEqual(currentRequestId(), id);
      assert.match(currentRequestId()!, uuid);
    });
    assert.equal(currentRequestId(), id);
  })));
  assert.equal(currentRequestId(), undefined);
});

test("failed asynchronous work cannot leak its request context", async () => {
  await assert.rejects(withRequestContext(first, async () => { throw new Error("failed"); }), /failed/);
  assert.equal(currentRequestId(), undefined);
});

test("upstream log routes discard queries, record IDs and unrecognized user-controlled families", () => {
  assert.equal(upstreamRoute("/v1/movements/private-person-id/notes?search=secret"), "/v1/movements");
  assert.equal(upstreamRoute("/v1/registry/subjects?search=private"), "/v1/registry");
  assert.equal(upstreamRoute("/v1/private-secret/123"), "/v1/other");
  assert.equal(upstreamRoute("https://secret.invalid/path"), "upstream");
});
