import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDashboardMovement, normalizeTerminalSnapshot } from "../lib/normalizeDashboard";
import { HttpDataService } from "../services/httpDataService";
import { isMovementEventId, movementLogHref } from "../lib/movementReferences";
import { applyPresenceUpdate, parsePresenceUpdate } from "../frontend/context/presenceUpdates";
import { emptyData } from "../frontend/context/dataDefaults";
import { queuedScanInput } from "../frontend/lib/offlineTerminalQueue";
import { readJsonBody } from "../lib/requestJson";
import type { DataState } from "../frontend/context/dataTypes";
import type { RecordScanInput } from "../lib/types";
import { escapeCsv } from "../lib/csv";

test("CSV exports keep untrusted names as text instead of spreadsheet formulas", () => {
  assert.equal(escapeCsv('Alice "A"'), '"Alice ""A"""');
  for (const text of ["=1+1", "  @SUM(1)", "+1", "-1", "\tformula"]) {
    assert.equal(escapeCsv(text), `"'${text}"`);
  }
});

test("HTTP and SSE delivery count one event and a retry never restores older presence", () => {
  const event = normalizeDashboardMovement({ id: "entry", subjectId: "p1", subjectType: "employee", result: "approved", direction: "entry", scanType: "auto" });
  const initial: DataState = { ...emptyData, isLoading: false, error: null };
  const entered = applyPresenceUpdate(initial, { movement: event });
  const duplicate = applyPresenceUpdate(entered, { movement: event });
  assert.equal(duplicate.movements.length, 1);
  assert.equal(duplicate.scanAnalytics.totalScans, 1);
  assert.equal(duplicate.scanAnalytics.activeInside, 1);
  const exited = applyPresenceUpdate(duplicate, { movement: { ...event, id: "exit", direction: "exit" } });
  const retry = applyPresenceUpdate(exited, { movement: event });
  assert.equal(retry.scanAnalytics.totalScans, 2);
  assert.equal(retry.scanAnalytics.activeInside, 0);
  const asset = applyPresenceUpdate(retry, { movement: { ...event, id: "asset", subjectType: "hardware" } });
  assert.equal(asset.scanAnalytics.activeInside, 0);
  assert.equal(parsePresenceUpdate('{"people":{}}'), null);
  assert.equal(parsePresenceUpdate('{"movement":{"id":"bad"}}'), null);
});

test("offline retries preserve the original attempted payload and support legacy queue entries", () => {
  const input: RecordScanInput = { barcode: "p1", checkpointId: "cp1", online: true, scanType: "auto", selectedHardwareIds: [] };
  const queued = { input, idempotencyKey: "retry", capturedOfflineAt: "2026-09-28T10:00:00Z", attempts: 0 };
  assert.deepEqual(queuedScanInput(queued), input);
  assert.deepEqual(queuedScanInput({ ...queued, input: { ...input, capturedOfflineAt: queued.capturedOfflineAt } }), { ...input, capturedOfflineAt: queued.capturedOfflineAt });
  const { online: _online, ...legacy } = input;
  assert.equal(queuedScanInput({ ...queued, input: legacy }).capturedOfflineAt, queued.capturedOfflineAt);
});

test("JSON commands reject cross-origin, non-JSON, malformed and chunked oversized bodies", async () => {
  const origin = process.env.AUTH_URL || "http://localhost:1008";
  const request = (body: string, headers: Record<string, string> = {}) => new Request(`${origin}/api/data`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
  assert.deepEqual(await readJsonBody(request('{"ok":true}')), { ok: true });
  await assert.rejects(readJsonBody(request('{}', { Origin: "https://attacker.invalid" })), { status: 403 });
  await assert.rejects(readJsonBody(request('{}', { "Content-Type": "text/plain" })), { status: 415 });
  await assert.rejects(readJsonBody(request('{')), { status: 400 });
  const streamed = new Request(`${origin}/api/data`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)); controller.close(); } }),
    duplex: "half",
  } as RequestInit);
  await assert.rejects(readJsonBody(streamed), { status: 413 });
});

test("movement rows use authoritative database state and preserve display metadata", () => {
  const event = normalizeDashboardMovement({ id: "m1", subject_id: "p1", checkpoint_id: "cp1",
    occurred_at: "2026-09-09T10:00:00Z", sync_state: "synced", scan_type: "auto", denial_code: "access_restricted",
    data: { id: "stale-display-id", subjectName: "Alice", barcode: "a1", syncState: "queued", checkpoint: "Main" } });
  assert.equal(event.id, "m1");
  assert.equal(event.subjectId, "p1"); assert.equal(event.subjectName, "Alice");
  assert.equal(event.syncState, "synced"); assert.equal(event.scanType, "auto");
  assert.equal(event.denialCode, "access_restricted");
});

test("full movement references support scan, manual, and legacy IDs without shortening them", () => {
  for (const id of ["5a62bc23-45d6-4789-abcd-123456789abc", "MAN-0123456789abcdef0123456789abcdef", "EVT-000123"]) {
    assert.equal(isMovementEventId(id), true);
    assert.equal(isMovementEventId(` ${id.toLowerCase()} `), true);
    assert.equal(new URL(movementLogHref(id), "http://localhost").searchParams.get("eventId"), id);
  }
  for (const value of ["Alice", "MAN-123", "EVT-", "5a62bc23", ""]) {
    assert.equal(isMovementEventId(value), false);
  }
  const legacyId = "legacy event?source=gate&index=1";
  assert.equal(new URL(movementLogHref(legacyId), "http://localhost").searchParams.get("eventId"), legacyId);
});

test("flat chart movements retain their names and barcodes", () => {
  const event = normalizeDashboardMovement({ id: "m1", subjectName: "Alice", barcode: "a1", scanType: "auto", createdAt: "2026-09-17T10:00:00Z" });
  assert.equal(event.subjectName, "Alice"); assert.equal(event.barcode, "a1");
  assert.equal(event.createdAt, "2026-09-17T10:00:00Z");
});

test("terminal bundle separates assets and applies authoritative presence", () => {
  const snapshot = normalizeTerminalSnapshot({ subjects: [
    { id: "p1", kind: "employee", name: "Alice", inside: false },
    { id: "h1", kind: "hardware", name: "Laptop", inside: true },
  ], presence: [{ subjectId: "p1", state: "inside" }, { subjectId: "h1", state: "outside" }] });
  assert.equal(snapshot.people.length, 1); assert.equal(snapshot.hardwareAssets.length, 1);
  assert.equal(snapshot.people[0].type, "employee"); assert.equal(snapshot.people[0].inside, true);
  assert.equal(snapshot.hardwareAssets[0].inside, false);
});

test("HTTP service forwards movement filters and creates scan idempotency keys", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ data: {} });
  };
  try {
    const service = new HttpDataService();
    await service.queryMovements({ page: 2, pageSize: 25, search: "Alice", startAt: "2026-09-09T00:00:00Z", scanType: "auto" });
    const params = new URL(calls[0].url, "http://localhost").searchParams;
    assert.equal(params.get("search"), "Alice"); assert.equal(params.get("page"), "2");
    assert.equal(params.get("scanType"), "auto");
    const eventId = "MAN-0123456789abcdef0123456789abcdef";
    await service.queryMovements({ page: 1, pageSize: 25, eventId });
    assert.equal(new URL(calls[1].url, "http://localhost").searchParams.get("eventId"), eventId);
    await service.recordScan({ barcode: "a1", checkpointId: "cp1", direction: "exit", selectedHardwareIds: ["h1"], online: true, scanType: "auto" });
    assert.match(new Headers(calls[2].init?.headers).get("Idempotency-Key")!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)).input.selectedHardwareIds, ["h1"]);
    assert.equal(JSON.parse(String(calls[2].init?.body)).input.direction, "exit");
  } finally { globalThis.fetch = original; }
});
