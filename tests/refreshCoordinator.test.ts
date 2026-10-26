import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefreshCoordinator } from "../lib/refreshCoordinator";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("focus and visibility bursts share one active read", async () => {
  const read = gate();
  let calls = 0;
  const queue = createRefreshCoordinator(async () => { calls++; await read.promise; });
  const first = queue.request();
  await Promise.resolve();
  const restores = Array.from({ length: 30 }, () => queue.request());
  assert.equal(calls, 1);
  assert.ok(restores.every(request => request === first));
  read.release();
  await Promise.all([first, ...restores]);
  assert.equal(calls, 1);
});

test("a mutation during a stale snapshot waits for one fresh read without overlapping requests", async () => {
  const oldRead = gate();
  const newReadStarted = gate();
  const newRead = gate();
  let source = "before mutation";
  let displayed = "";
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const queue = createRefreshCoordinator(async () => {
    const snapshot = source;
    calls++;
    maxActive = Math.max(maxActive, ++active);
    if (calls === 1) await oldRead.promise;
    else { newReadStarted.release(); await newRead.promise; }
    displayed = snapshot;
    active--;
  });
  const first = queue.request();
  await Promise.resolve();
  source = "after mutation";
  let settled = false;
  const writes = Array.from({ length: 20 }, () => queue.request(true));
  void Promise.all(writes).then(() => { settled = true; });
  oldRead.release();
  await newReadStarted.promise;
  assert.equal(calls, 2);
  assert.equal(displayed, "before mutation");
  assert.equal(settled, false);
  newRead.release();
  await Promise.all([first, ...writes]);
  assert.equal(displayed, "after mutation");
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("a reconnect during the follow-up still reconciles its later stream gap", async () => {
  const reads = [gate(), gate(), gate()];
  const started = [gate(), gate(), gate()];
  let calls = 0;
  const queue = createRefreshCoordinator(async () => {
    const index = calls++;
    started[index].release();
    await reads[index].promise;
  });
  const first = queue.request();
  await started[0].promise;
  void queue.request(true);
  reads[0].release();
  await started[1].promise;
  const reconnect = queue.request(true);
  reads[1].release();
  await started[2].promise;
  reads[2].release();
  await Promise.all([first, reconnect]);
  assert.equal(calls, 3);
});

test("a burst before a read starts does not enqueue an unnecessary second read", async () => {
  let calls = 0;
  const queue = createRefreshCoordinator(async () => { calls++; });
  await Promise.all([queue.request(), queue.request(true), queue.request(true)]);
  assert.equal(calls, 1);
});

test("a failed read can be retried without retaining a rejected promise", async () => {
  let calls = 0;
  const queue = createRefreshCoordinator(async () => {
    if (++calls === 1) throw new Error("temporarily unavailable");
  });
  await assert.rejects(queue.request(), /temporarily unavailable/);
  await queue.request();
  assert.equal(calls, 2);
});

test("scope cleanup cancels queued reads while allowing a later activation to refresh", async () => {
  const oldRead = gate();
  let calls = 0;
  const queue = createRefreshCoordinator(async () => {
    if (++calls === 1) await oldRead.promise;
  });
  const first = queue.request();
  await Promise.resolve();
  void queue.request(true);
  queue.clearPending();
  oldRead.release();
  await first;
  assert.equal(calls, 1);
  await queue.request(true);
  assert.equal(calls, 2);
});

test("independent providers never share in-flight work or user data", async () => {
  const aliceRead = gate();
  const completed: string[] = [];
  const alice = createRefreshCoordinator(async () => { await aliceRead.promise; completed.push("alice"); });
  const bob = createRefreshCoordinator(async () => { completed.push("bob"); });
  const first = alice.request();
  await bob.request();
  assert.deepEqual(completed, ["bob"]);
  aliceRead.release();
  await first;
  assert.deepEqual(completed, ["bob", "alice"]);
});
