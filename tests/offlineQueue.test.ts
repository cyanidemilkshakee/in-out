import test from "node:test";
import assert from "node:assert/strict";
import {
  isPermanentQueueFailure, queuedScanHoldReason, queuedScanInput,
  syncQueuedTerminalScans, visibleQueuedScans,
  enqueueTerminalScan, holdQueuedTerminalScan, listQueuedTerminalScans, recordQueuedScanFailure,
  sampleQueueServerClock, queueCaptureTime, heldTerminalScanEvidence, cacheTerminalConfig, loadCachedTerminalConfig,
  type QueueContext, type QueuedTerminalScan,
} from "../frontend/lib/offlineTerminalQueue";

const policy = { receiptRetentionDays: 30, serverTime: "2026-10-19T08:00:00Z" };
const context: QueueContext = { operatorSubject: "operator-a", checkpointId: "cp-main", replayClock: sampleQueueServerClock(policy) };
function scan(key: string, fields: Partial<QueuedTerminalScan> = {}): QueuedTerminalScan {
  return { idempotencyKey: key, operatorSubject: "operator-a", status: "pending", attempts: 0,
    capturedOfflineAt: "2026-10-09T08:00:00Z",
    replayCapturedAt: "2026-10-09T08:00:00Z",
    input: { barcode: key, checkpointId: "cp-main", online: true, scanType: "auto", selectedHardwareIds: ["h1"], expectedOperatorSubject: "operator-a" }, ...fields };
}
function harness(sendFailure?: (key: string) => unknown) {
  let current = { ...context };
  const sent: { input: ReturnType<typeof queuedScanInput>; key: string }[] = [];
  const removed: string[] = [];
  const held: { key: string; reason: string }[] = [];
  const failures: { key: string; error: string; permanent: boolean }[] = [];
  return { sent, removed, held, failures, setContext: (next: QueueContext) => { current = next; },
    actions: {
      loadReplayPolicy: async () => policy,
      currentContext: () => current,
      send: async (input: ReturnType<typeof queuedScanInput>, key: string) => {
        sent.push({ input, key });
        const failure = sendFailure?.(key);
        if (failure) throw failure;
      },
      remove: async (key: string) => { removed.push(key); },
      hold: async (key: string, reason: string) => { held.push({ key, reason }); },
      fail: async (key: string, error: string, permanent: boolean) => { failures.push({ key, error, permanent }); },
    } };
}
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test("a shared terminal only shows and sends the signed-in operator's scans", async () => {
  const foreign = scan("other-account", { operatorSubject: "operator-b" });
  const own = scan("own");
  const h = harness();
  assert.deepEqual(visibleQueuedScans([foreign, own], context.operatorSubject), [own]);
  assert.deepEqual(await syncQueuedTerminalScans([foreign, own], context, h.actions), { synced: 1, held: 0, paused: null });
  assert.deepEqual(h.sent.map(item => item.key), ["own"]);
  assert.deepEqual(h.removed, ["own"]);
  assert.deepEqual(h.held, []);
});

test("unowned legacy and reassigned checkpoint records retain evidence without blocking later scans", async () => {
  const legacy = scan("legacy", { operatorSubject: undefined });
  const reassigned = scan("previous-checkpoint", { input: { ...scan("previous-checkpoint").input, checkpointId: "server-room" } });
  const original = JSON.stringify([legacy, reassigned]);
  const h = harness();
  const result = await syncQueuedTerminalScans([legacy, reassigned, scan("ready")], context, h.actions, true);
  assert.deepEqual(result, { synced: 1, held: 2, paused: null });
  assert.deepEqual(h.held.map(item => item.key), ["legacy", "previous-checkpoint"]);
  assert.deepEqual(h.sent.map(item => item.key), ["ready"]);
  assert.equal(JSON.stringify([legacy, reassigned]), original);
  assert.equal(queuedScanHoldReason(scan("alias", { input: { ...scan("alias").input, checkpointId: "main-gate" } }), context), null,
    "the Phase 2 main-gate alias normalizes to the assigned main checkpoint");
});

for (const status of [400, 403, 404, 409, 422]) {
  test(`HTTP ${status} holds only its failed record and verifies the later scan`, async () => {
    const h = harness(key => key === "bad" ? httpError(status) : null);
    assert.deepEqual(await syncQueuedTerminalScans([scan("bad"), scan("good")], context, h.actions), { synced: 1, held: 1, paused: null });
    assert.deepEqual(h.removed, ["good"]);
    assert.deepEqual(h.failures, [{ key: "bad", error: `HTTP ${status}`, permanent: true }]);
  });
}

for (const failure of [httpError(401), httpError(408), httpError(429), httpError(500), new TypeError("Network unavailable")]) {
  test(`${failure.message} pauses transport and leaves later evidence untouched`, async () => {
    const h = harness(() => failure);
    assert.deepEqual(await syncQueuedTerminalScans([scan("first"), scan("later")], context, h.actions), { synced: 0, held: 0, paused: failure.message });
    assert.deepEqual(h.sent.map(item => item.key), ["first"]);
    assert.deepEqual(h.removed, []);
    assert.equal(h.failures[0].permanent, false);
    assert.equal(isPermanentQueueFailure(failure), false);
  });
}

test("held records require explicit recovery and reuse the exact attempted key and input", async () => {
  const item = scan("lost-response", { status: "held", heldReason: "HTTP 409" });
  const h = harness();
  await syncQueuedTerminalScans([item], context, h.actions);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await syncQueuedTerminalScans([item], context, h.actions, true), { synced: 1, held: 0, paused: null });
  assert.deepEqual(h.sent[0], { input: { ...item.input, queueCapturedAt: item.replayCapturedAt }, key: item.idempotencyKey });
  assert.equal(h.sent[0].input.capturedOfflineAt, undefined);
  h.sent[0].input.selectedHardwareIds.push("mutated");
  assert.deepEqual(item.input.selectedHardwareIds, ["h1"]);
});

test("changing operator or checkpoint while retrying stops subsequent submissions", async () => {
  for (const changed of [{ ...context, operatorSubject: "operator-b" }, { ...context, checkpointId: "server-room" }]) {
    const h = harness();
    h.actions.remove = async key => { h.removed.push(key); h.setContext(changed); };
    const result = await syncQueuedTerminalScans([scan("first"), scan("later")], context, h.actions);
    assert.equal(result.synced, 1);
    assert.match(result.paused!, /changed/);
    assert.deepEqual(h.sent.map(item => item.key), ["first"]);
  }
});

// A tiny asynchronous IndexedDB fixture verifies the actual persistence
// functions without introducing a production/browser test dependency.
async function withOfflineStorage(run: (records: Map<string, QueuedTerminalScan>) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const records = new Map<string, QueuedTerminalScan>();
  const configRecords = new Map<string, unknown>();
  const database = {
    close() {},
    transaction(storeName: string) {
      const entries: Map<string, unknown> = storeName === "terminal-config" ? configRecords : records;
      const transaction = { oncomplete: undefined as (() => void) | undefined, objectStore: () => store };
      const complete = () => setImmediate(() => transaction.oncomplete?.());
      const request = (value: unknown) => {
        const result = { result: structuredClone(value), onsuccess: undefined as (() => void) | undefined };
        setImmediate(() => { result.onsuccess?.(); complete(); });
        return result;
      };
      const store = {
        get: (key: string) => request(entries.get(key)),
        getAll: () => request([...entries.values()]),
        put: (value: QueuedTerminalScan & { id?: string }) => { entries.set(value.id ?? value.idempotencyKey, structuredClone(value)); complete(); },
      };
      return transaction;
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { indexedDB: {
    open: () => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined };
      setImmediate(() => request.onsuccess?.());
      return request;
    },
  } } });
  try { await run(records); }
  finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("offline storage binds the operator and cannot overwrite another owner's original evidence", async () => {
  await withOfflineStorage(async records => {
    const input = queuedScanInput(scan("stored"));
    const original = await enqueueTerminalScan({ ...input, online: true }, "operator-a", "stored");
    assert.equal(original.status, "held");
    assert.match(original.heldReason!, /server capture time/);
    assert.equal(records.get("stored")?.operatorSubject, "operator-a");
    assert.equal(records.get("stored")?.input.expectedOperatorSubject, "operator-a");
    await assert.rejects(enqueueTerminalScan({ ...input, expectedOperatorSubject: "operator-b" }, "operator-b", "stored"), /already belongs/);
    await assert.rejects(enqueueTerminalScan({ ...input, barcode: "different" }, "operator-a", "stored"), /already belongs/);
    assert.deepEqual(records.get("stored"), original);
    input.selectedHardwareIds.push("changed-after-capture");
    assert.deepEqual(records.get("stored")?.input.selectedHardwareIds, ["h1"]);
  });
});

test("retention boundaries use the server clock and immutable sidecar, never browser capture dates", () => {
  const clock = sampleQueueServerClock(policy, 0, 0)!;
  const fixed = { ...context, replayClock: clock };
  const justInside = scan("inside", { replayCapturedAt: "2026-09-19T08:00:00.001Z", capturedOfflineAt: "1900-01-01T00:00:00Z" });
  assert.equal(queuedScanHoldReason(justInside, fixed, 0), null);
  assert.match(queuedScanHoldReason(scan("edge", { replayCapturedAt: "2026-09-19T08:00:00Z" }), fixed, 0)!, /receipt-retention/);
  assert.match(queuedScanHoldReason(scan("future", { replayCapturedAt: "2026-10-19T08:00:00.001Z" }), fixed, 0)!, /server clock/);
  for (const replayCapturedAt of [undefined, "invalid", "2026-10-09T08:00:00", "2026-02-30T08:00:00Z"]) {
    assert.match(queuedScanHoldReason(scan("legacy", { replayCapturedAt }), fixed, 0)!, /no verified server capture/);
  }
  assert.equal(queueCaptureTime(clock, 1000), "2026-10-19T08:00:01.000Z");
  assert.equal(queueCaptureTime(clock, -1), undefined);
  assert.equal(sampleQueueServerClock({ ...policy, receiptRetentionDays: -1 }), undefined);
});

test("round-trip uncertainty holds conservatively at expiration and zero means indefinite receipt retention", () => {
  const nearEdge = scan("near-edge", { replayCapturedAt: "2026-09-19T08:00:00.050Z" });
  const delayed = sampleQueueServerClock(policy, 0, 100)!;
  assert.match(queuedScanHoldReason(nearEdge, { ...context, replayClock: delayed }, 100)!, /receipt-retention/);
  const indefinite = sampleQueueServerClock({ ...policy, receiptRetentionDays: 0 }, 0, 0)!;
  assert.equal(queuedScanHoldReason(scan("old", { replayCapturedAt: "2000-01-01T00:00:00Z" }), { ...context, replayClock: indefinite }, 0), null);
  assert.match(queuedScanHoldReason(scan("legacy", { replayCapturedAt: undefined }), { ...context, replayClock: indefinite }, 0)!, /verified/);
});

test("automatic and explicit retries cannot bypass expiration, missing evidence, or unavailable current policy", async () => {
  for (const retryHeld of [false, true]) {
    for (const item of [scan("expired", { status: "held", replayCapturedAt: "2026-09-19T08:00:00Z" }), scan("legacy", { replayCapturedAt: undefined })]) {
      const h = harness();
      const original = JSON.stringify(item);
      assert.deepEqual(await syncQueuedTerminalScans([item], context, h.actions, retryHeld), { synced: 0, held: 1, paused: null });
      assert.equal(h.sent.length, 0);
      assert.equal(h.removed.length, 0);
      assert.equal(JSON.stringify(item), original);
    }
    const h = harness();
    h.actions.loadReplayPolicy = async () => { throw new Error("Offline"); };
    await syncQueuedTerminalScans([scan("safe-hold")], context, h.actions, retryHeld);
    assert.equal(h.sent.length, 0);
    assert.match(h.held[0].reason, /fresh server replay policy/);
    assert.equal(h.removed.length, 0);
  }
});

test("queue exports preserve original fingerprint evidence and exclude other accounts", () => {
  const item = scan("expired", { status: "held", replayCapturedAt: "2026-01-01T00:00:00Z" });
  const original = JSON.stringify(item);
  const exported = heldTerminalScanEvidence([item, scan("foreign", { operatorSubject: "operator-b" })], context, "2026-10-19T08:01:00Z");
  assert.equal(exported.scans.length, 1);
  assert.equal(exported.scans[0].idempotencyKey, item.idempotencyKey);
  assert.deepEqual(exported.scans[0].input, item.input);
  assert.equal(exported.scans[0].input.queueCapturedAt, undefined);
  assert.match(exported.scans[0].heldReason!, /receipt-retention/);
  assert.equal(JSON.stringify(item), original);
  exported.scans[0].input.selectedHardwareIds.push("export-only");
  assert.equal(JSON.stringify(item), original);
});

test("legacy evidence missing capture timestamps can still be listed, held, and exported", async () => {
  await withOfflineStorage(async records => {
    const legacy = scan("no-date", { capturedOfflineAt: undefined as unknown as string, replayCapturedAt: undefined });
    records.set(legacy.idempotencyKey, legacy);
    records.set("newer", scan("newer"));
    const listed = await listQueuedTerminalScans();
    const h = harness();
    await syncQueuedTerminalScans(listed, context, h.actions, true);
    assert.ok(h.held.some(item => item.key === legacy.idempotencyKey));
    assert.ok(!h.sent.some(item => item.key === legacy.idempotencyKey));
    const exported = heldTerminalScanEvidence([legacy], context, "2026-10-19T08:01:00Z");
    assert.deepEqual(exported.scans[0].input, legacy.input);
    assert.equal(records.get(legacy.idempotencyKey), legacy);
  });
});

test("trusted queue capture and cached policy survive reload without rewriting original input", async () => {
  await withOfflineStorage(async () => {
    const item = scan("trusted-persisted");
    const created = await enqueueTerminalScan(item.input as ReturnType<typeof queuedScanInput>, "operator-a", item.idempotencyKey, item.replayCapturedAt);
    await holdQueuedTerminalScan(item.idempotencyKey, "Receipt window expired");
    const reloaded = (await listQueuedTerminalScans())[0];
    assert.equal(reloaded.replayCapturedAt, item.replayCapturedAt);
    assert.deepEqual(reloaded.input, created.input);
    assert.equal(reloaded.input.queueCapturedAt, undefined);
    await cacheTerminalConfig({ operatorSubject: "operator-a", checkpoints: [], hardwareAssets: [], terminalReplayPolicy: policy });
    assert.deepEqual((await loadCachedTerminalConfig())?.terminalReplayPolicy, policy);
    const h = harness();
    h.actions.loadReplayPolicy = async () => { throw new Error("Cannot refresh cached policy"); };
    await syncQueuedTerminalScans([reloaded], context, h.actions, true);
    assert.equal(h.sent.length, 0);
  });
});

test("held scan evidence survives reload and repeated enqueue without losing attempts or changing the scan", async () => {
  await withOfflineStorage(async records => {
    const input = queuedScanInput(scan("held-persisted"));
    const original = await enqueueTerminalScan(input, "operator-a", "held-persisted");
    await recordQueuedScanFailure("held-persisted", "HTTP 422", true);
    let reloaded = (await listQueuedTerminalScans())[0];
    assert.equal(reloaded.status, "held");
    assert.equal(reloaded.attempts, 1);
    assert.equal(reloaded.heldReason, "HTTP 422");
    assert.deepEqual(reloaded.input, original.input);
    const duplicate = await enqueueTerminalScan(input, "operator-a", "held-persisted");
    assert.deepEqual(duplicate, reloaded);
    await holdQueuedTerminalScan("held-persisted", "Restore original checkpoint");
    reloaded = (await listQueuedTerminalScans())[0];
    assert.equal(reloaded.attempts, 1);
    assert.equal(reloaded.heldReason, "Restore original checkpoint");
    assert.equal(reloaded.heldAt, duplicate.heldAt);
    assert.deepEqual(reloaded.input, original.input);
    assert.equal(records.size, 1);
  });
});
