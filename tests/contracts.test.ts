import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDashboardMovement, normalizeTerminalSnapshot, normalizePermissionsSnapshot, normalizeDashboardSnapshot, normalizePermissionRequest, normalizeAuditEvent } from "../lib/normalizeDashboard";
import { HttpDataService } from "../services/httpDataService";
import { isMovementEventId, movementLogHref } from "../lib/movementReferences";
import { applyPresenceUpdate, parsePresenceUpdate } from "../frontend/context/presenceUpdates";
import { emptyData } from "../frontend/context/dataDefaults";
import { queuedScanInput } from "../frontend/lib/offlineTerminalQueue";
import { readJsonBody } from "../lib/requestJson";
import type { DataState } from "../frontend/context/dataTypes";
import type { RecordScanInput } from "../lib/types";
import { escapeCsv } from "../lib/csv";
import { FACILITY_ZONES, formatFacilityZones, normalizeFacilityCheckpoints, normalizeFacilityZones } from "../lib/facilityZones";
import { getDashboardKPIs } from "../lib/analyticsUtils";
import { mergeMovementRevisions } from "../lib/movementRevisions";
import { DEFAULT_MANUAL_REVIEW_MINUTES, isManualReviewDuration } from "../lib/manualReviewDuration";
import { mergePermissionRequests } from "../lib/permissionRequestRevisions";

test("delayed pending live events cannot reopen a completed permission or resurrect its notification", () => {
  const pending = normalizePermissionRequest({ id: "permission", status: "pending", createdAt: "2026-10-06T10:00:00Z" });
  const approved = { ...pending, status: "approved" as const, decidedAt: "2026-10-06T10:01:00Z" };
  const saved = mergePermissionRequests([pending], [approved]);
  const state: DataState = { ...emptyData, isLoading: false, error: null, permissionRequests: saved };
  const late = applyPresenceUpdate(state, { request: pending });
  assert.equal(late.permissionRequests[0].status, "approved");
  assert.equal(late.permissionRequests.filter(request => request.status === "pending").length, 0);
  const dismissed = { ...approved, notificationDismissedAt: "2026-10-06T10:02:00Z" };
  assert.deepEqual(mergePermissionRequests([dismissed], [approved]), [dismissed]);
});

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
  const input: RecordScanInput = { barcode: "p1", checkpointId: "main-gate", online: true, scanType: "auto", selectedHardwareIds: [] };
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

test("manual review finalizes one denied scan and stale retries cannot undo its presence", () => {
  const person = normalizeTerminalSnapshot({ subjects: [{ id: "p1", kind: "employee", name: "Alice", inside: false }] }).people[0];
  const denied = normalizeDashboardMovement({ id: "scan1", subjectId: person.id, subjectType: "employee", result: "denied", direction: "entry", scanType: "auto" });
  const initial: DataState = { ...emptyData, people: [person], isLoading: false, error: null };
  const scanned = applyPresenceUpdate(initial, { movement: denied });
  const approved = normalizeDashboardMovement({ ...denied, result: "approved", scanType: "manual", manualReviewedAt: "2026-10-04T10:00:00Z", overrideRequestId: "request1" });
  const review = { movement: approved, people: [{ ...person, inside: true }] };
  const finalized = applyPresenceUpdate(scanned, review);
  assert.equal(finalized.people[0].inside, true);
  assert.equal(finalized.scanAnalytics.activeInside, 1);
  assert.equal(finalized.scanAnalytics.totalScans, 1);
  assert.equal(finalized.scanAnalytics.totalApproved, 1);
  assert.equal(finalized.scanAnalytics.totalDenied, 0);
  assert.equal(finalized.scanAnalytics.totalAutomatic, 0);
  assert.equal(finalized.scanAnalytics.totalManual, 1);
  const repeated = applyPresenceUpdate(finalized, review);
  assert.equal(repeated.scanAnalytics.activeInside, 1);
  const exited = applyPresenceUpdate(repeated, { movement: { ...approved, id: "exit1", direction: "exit", scanType: "auto", manualReviewedAt: undefined }, people: [person] });
  const stale = applyPresenceUpdate(exited, { movement: denied, people: [person] });
  const reviewRetry = applyPresenceUpdate(stale, review);
  assert.equal(reviewRetry.people[0].inside, false);
  assert.equal(reviewRetry.scanAnalytics.activeInside, 0);
  assert.equal(reviewRetry.scanAnalytics.totalApproved, 2);
  assert.equal(reviewRetry.scanAnalytics.totalAutomatic, 1);
  assert.equal(reviewRetry.scanAnalytics.totalManual, 1);
  assert.equal(reviewRetry.movements.find(item => item.id === "scan1")?.result, "approved");
});

test("manual denial reclassifies one automatic scan without changing presence or double-counting retries", () => {
  const person = normalizeTerminalSnapshot({ subjects: [{ id: "p1", kind: "employee", name: "Alice", inside: false }] }).people[0];
  const automatic = normalizeDashboardMovement({ id: "manual-denial", subjectId: person.id, subjectType: "employee",
    result: "denied", direction: "entry", scanType: "auto", denialCode: "access_restricted", createdAt: "2026-10-06T10:00:00Z" });
  const manual = normalizeDashboardMovement({ ...automatic, scanType: "manual", denialCode: "manual_review",
    manualReviewedAt: "2026-10-06T10:01:00Z", overrideRequestId: "denied-request" });
  const initial: DataState = { ...emptyData, people: [person], isLoading: false, error: null };
  const scanned = applyPresenceUpdate(initial, { movement: automatic });
  assert.equal(scanned.scanAnalytics.totalAutomatic, 1);
  assert.equal(scanned.scanAnalytics.totalManual, 0);
  const finalized = applyPresenceUpdate(scanned, { movement: manual });
  assert.equal(finalized.movements.length, 1);
  assert.equal(finalized.scanAnalytics.totalScans, 1);
  assert.equal(finalized.scanAnalytics.totalDenied, 1);
  assert.equal(finalized.scanAnalytics.totalAutomatic, 0);
  assert.equal(finalized.scanAnalytics.totalManual, 1);
  assert.equal(finalized.scanAnalytics.activeInside, 0);
  assert.equal(finalized.people[0].inside, false);
  const repeated = applyPresenceUpdate(finalized, { movement: manual });
  const stale = applyPresenceUpdate(repeated, { movement: automatic });
  assert.deepEqual(stale.scanAnalytics, finalized.scanAnalytics);
  assert.deepEqual(stale.movements, [manual]);
});

test("dashboard chart revisions replace automatic denials and preserve fetched history against stale refreshes", () => {
  const automatic = normalizeDashboardMovement({ id: "chart-review", subjectType: "visitor", result: "denied",
    direction: "entry", scanType: "auto", createdAt: "2026-10-06T10:00:00Z" });
  const manual = normalizeDashboardMovement({ ...automatic, scanType: "manual", reason: "ID mismatch",
    manualReviewedAt: "2026-10-06T10:01:00Z", overrideRequestId: "chart-request" });
  let chart = mergeMovementRevisions([], [automatic]);
  assert.equal(getDashboardKPIs(chart).totalAutomatic, 1);
  assert.equal(getDashboardKPIs(chart).totalManual, 0);
  chart = mergeMovementRevisions(chart, [manual]);
  assert.equal(chart.length, 1);
  assert.equal(getDashboardKPIs(chart).totalAutomatic, 0);
  assert.equal(getDashboardKPIs(chart).totalManual, 1);
  assert.equal(getDashboardKPIs(chart).totalDenied, 1);
  chart = mergeMovementRevisions(chart, [manual, automatic]);
  assert.deepEqual(chart, [manual]);
  const history = normalizeDashboardMovement({ id: "earlier-range", subjectType: "employee", result: "approved",
    direction: "entry", scanType: "auto", createdAt: "2026-10-05T08:00:00Z" });
  // A range request started before the decision can return its old scan row.
  chart = mergeMovementRevisions(chart, [history, automatic]);
  assert.deepEqual(chart.map((movement) => movement.id), [history.id, manual.id]);
  assert.equal(chart.find((movement) => movement.id === manual.id)?.scanType, "manual");
  const olderReview = { ...manual, reason: "Older response", manualReviewedAt: "2026-10-06T10:00:30Z" };
  chart = mergeMovementRevisions(chart, [olderReview]);
  assert.equal(chart.find((movement) => movement.id === manual.id)?.reason, "ID mismatch");
  const persisted = normalizeDashboardMovement({ id: manual.id, scan_type: "manual", result: "denied",
    data: { ...manual, scanType: "auto" } });
  assert.equal(persisted.scanType, "manual", "Reloads use the authoritative movement column");
  chart = mergeMovementRevisions(chart, [persisted]);
  assert.equal(chart.length, 2);
  assert.equal(getDashboardKPIs(chart).totalAutomatic, 1);
  assert.equal(getDashboardKPIs(chart).totalManual, 1);
});

test("zone requests retain their type and access snapshot in manager and dashboard", () => {
  const request = { id: "req-zone", type: "zone_access", status: "pending", subjectId: "p1", subjectName: "Alice",
    requestedZones: ["public", "secure"], previousZones: ["Main Entrance"], previousValidTo: "2026-10-04T12:00:00Z" };
  const manager = normalizePermissionsSnapshot({ requests: [request], people: [{ id: "perm", subjectId: "p1" }],
    subjects: [{ id: "p1", type: "employee", name: "Alice" }, { id: "h1", type: "hardware", name: "Laptop" }],
    checkpoints: [{ id: "cp-main", name: "Main Entrance", zone: "public" }] });
  assert.equal(manager.permissionRequests[0].type, "zone_access");
  assert.deepEqual(manager.permissionRequests[0].previousZones, ["public"]);
  assert.equal(manager.permissions[0].subjectId, "p1");
  assert.equal(manager.people[0].name, "Alice");
  assert.equal(manager.hardwareAssets[0].name, "Laptop");
  assert.equal(manager.checkpoints[0].id, "cp-main");
  assert.equal(normalizeDashboardSnapshot({ pendingDecisions: [request] }).permissionRequests[0].type, "zone_access");
});

test("live requests and permission updates preserve presence and merge each request once", () => {
  const initial: DataState = { ...emptyData, isLoading: false, error: null };
  const request = normalizePermissionRequest({ id: "req1", subjectId: "visitor", type: "visitor", status: "pending" });
  const received = applyPresenceUpdate(initial, { request, permission: {
    id: "perm", subjectId: "visitor", subjectName: "Guest", subjectType: "visitor", assignment: "Visit",
    state: "pending_approval", zones: [], validFrom: "", validTo: "", source: "request", updatedAt: "", updatedBy: "admin",
  } });
  assert.equal(received.permissionRequests[0].status, "pending");
  assert.equal(received.permissions[0].state, "pending_approval");
  const approved = applyPresenceUpdate(received, { request: { ...request, status: "approved" },
    permission: { ...received.permissions[0], state: "active" } });
  const replay = applyPresenceUpdate(approved, { request: { ...request, status: "approved" } });
  assert.equal(replay.permissionRequests.length, 1);
  assert.equal(replay.permissionRequests[0].status, "approved");
  assert.equal(replay.permissions[0].state, "active");
  assert.equal(replay.scanAnalytics.activeInside, 0);
  assert.equal(replay.movements.length, 0);
  assert.equal(parsePresenceUpdate('{"request":{"title":"missing id"}}'), null);
  assert.equal(parsePresenceUpdate('{"permission":{"state":"active"}}'), null);
});

test("manual-review duration policy accepts only the five choices without coercing input", () => {
  assert.equal(DEFAULT_MANUAL_REVIEW_MINUTES, 60);
  for (const minutes of [15, 30, 60, 120, 240]) assert.equal(isManualReviewDuration(minutes), true);
  for (const value of [45, 14, 241, "60", "15", 15.5, true, false, undefined, null, NaN, Infinity]) {
    assert.equal(isManualReviewDuration(value), false, `Unexpected accepted duration: ${String(value)}`);
  }
});

test("manual approval commands preserve each chosen duration and omit it from denials", async () => {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: {} });
  };
  try {
    const service = new HttpDataService();
    const requestId = "13131313-1313-4313-8313-131313131313";
    for (const minutes of [15, 30, 60, 120, 240]) {
      await service.decidePermissionRequest(requestId, "approved", "Identity verified", minutes);
      assert.deepEqual(bodies.at(-1), { action: "decidePermissionRequest", requestId, decision: "approved",
        reason: "Identity verified", validForMinutes: minutes });
    }
    await service.decidePermissionRequest(requestId, "denied", "Identity could not be verified");
    assert.deepEqual(bodies.at(-1), { action: "decidePermissionRequest", requestId, decision: "denied",
      reason: "Identity could not be verified" });
    assert.equal(bodies.length, 6);
  } finally { globalThis.fetch = original; }
});

test("completed decision notices can be dismissed repeatedly without a scan retry key", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = normalizePermissionRequest({ id: "12121212-1212-4212-8212-121212121212", type: "manual_override",
    status: "denied", checkpointId: "cp-main", eventId: "scan1", decisionReason: "Identity could not be verified",
    decidedAt: "2026-10-06T10:01:00Z",
    notificationDismissedAt: "2026-10-06T10:02:00Z", notificationDismissedBy: "operator1" });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ data: request });
  };
  try {
    const service = new HttpDataService();
    const dismissed = await service.dismissPermissionNotification(request.id);
    const repeated = await service.dismissPermissionNotification(request.id);
    assert.deepEqual(repeated, dismissed);
    assert.equal(dismissed.id, request.id);
    assert.equal(dismissed.status, "denied");
    assert.equal(dismissed.decisionReason, request.decisionReason);
    assert.equal(dismissed.decidedAt, request.decidedAt);
    assert.equal(dismissed.notificationDismissedAt, request.notificationDismissedAt);
    assert.equal(dismissed.notificationDismissedBy, request.notificationDismissedBy);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "/api/data");
      assert.equal(call.init?.method, "POST");
      assert.deepEqual(JSON.parse(String(call.init?.body)), { action: "dismissPermissionNotification", requestId: request.id });
    }
  } finally { globalThis.fetch = original; }
});

test("dismissing approved and denied notices preserves decisions, presence and movement history", () => {
  for (const status of ["approved", "denied"] as const) {
    const snapshot = normalizeTerminalSnapshot({ subjects: [
      { id: "p1", kind: "employee", name: "Alice", inside: status === "approved" },
      { id: "h1", kind: "hardware", name: "Laptop", inside: status === "approved", assignedTo: "p1" },
    ] });
    const request = normalizePermissionRequest({ id: `request-${status}`, type: "manual_override", status,
      subjectId: "p1", checkpointId: "cp-main", eventId: `scan-${status}`, operatorNote: "Check identity",
      decidedAt: "2026-10-06T10:01:00Z",
      decisionReason: status === "approved" ? "Identity verified" : "Identity could not be verified" });
    const movement = normalizeDashboardMovement({ id: request.eventId, subjectId: "p1", subjectType: "employee",
      result: status, direction: "entry", scanType: "manual", manualReviewedAt: "2026-10-06T10:01:00Z",
      overrideRequestId: request.id, createdAt: "2026-10-06T10:00:00Z" });
    const permissions = normalizePermissionsSnapshot({ people: [{ id: "perm1", subjectId: "p1", state: "active", zones: ["public"] }] }).permissions;
    const audit = normalizeAuditEvent({ id: `audit-${status}`, category: "permission", action: `Manual review ${status}`,
      relatedId: request.id, createdAt: "2026-10-06T10:01:00Z", actor: "admin1" });
    const initial: DataState = { ...emptyData, people: snapshot.people, hardwareAssets: snapshot.hardwareAssets, permissions,
      auditEvents: [audit], scanAnalytics: { ...emptyData.scanAnalytics, activeInside: Number(status === "approved") }, isLoading: false, error: null };
    const completed = applyPresenceUpdate(initial, { movement, request });
    const update = parsePresenceUpdate(JSON.stringify({ type: "terminal_notification_dismissed", requestId: request.id,
      request: { ...request, notificationDismissedAt: "2026-10-06T10:02:00Z", notificationDismissedBy: "operator1" } }));
    assert.ok(update);
    const dismissed = applyPresenceUpdate(completed, update);
    const replay = applyPresenceUpdate(dismissed, update);
    assert.deepEqual(replay.permissionRequests, [{ ...request, notificationDismissedAt: "2026-10-06T10:02:00Z", notificationDismissedBy: "operator1" }]);
    assert.equal(replay.permissionRequests[0].status, status, "Closing a denied notice must not approve the request");
    assert.deepEqual(replay.scanAnalytics, completed.scanAnalytics);
    assert.deepEqual(replay.people, completed.people);
    assert.deepEqual(replay.hardwareAssets, completed.hardwareAssets);
    assert.deepEqual(replay.permissions, completed.permissions);
    assert.deepEqual(replay.movements, completed.movements);
    assert.deepEqual(replay.auditEvents, completed.auditEvents);
  }
});

test("paper movements retain their source and transcription time", () => {
  const event = normalizeDashboardMovement({ id: "paper", occurred_at: "2026-10-01T08:00:00Z", data: {
    source: "paper_register", paperReference: "Register A / page 12", loggedAt: "2026-10-04T08:00:00Z", historicalVisitId: "visit1",
  } });
  assert.equal(event.createdAt, "2026-10-01T08:00:00Z");
  assert.equal(event.loggedAt, "2026-10-04T08:00:00Z");
  assert.equal(event.source, "paper_register");
  assert.equal(event.paperReference, "Register A / page 12");
});

test("permission mutation audits normalize both legacy and decision timestamps for display", () => {
  const permissionChange = normalizeAuditEvent({ id: "audit1", category: "permission", action: "Manual permission changed",
    subjectId: "p1", subjectName: "Alice", timestamp: "2026-10-05T08:30:00Z", performedBy: "manager",
    decisionReason: "Access reviewed" });
  assert.equal(permissionChange.createdAt, "2026-10-05T08:30:00Z");
  assert.equal(permissionChange.date, "2026-10-05");
  assert.equal(permissionChange.time, "08:30");
  assert.equal(permissionChange.actor, "manager");
  assert.equal(permissionChange.reason, "Access reviewed");
  const decision = normalizeAuditEvent({ id: "audit2", category: "permission", action: "Visitor approved",
    subjectId: "visitor1", subjectName: "Guest", createdAt: "2026-10-05T09:00:00Z", actor: "manager",
    relatedId: "req1", decision: "granted" });
  assert.equal(decision.createdAt, "2026-10-05T09:00:00Z");
  assert.equal(decision.date, "2026-10-05");
  assert.equal(decision.time, "09:00");
  assert.equal(decision.relatedId, "req1");
  assert.equal(decision.decision, "granted");
});

test("alert counts use the dedicated uncached resource and preserve zero", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const totals = [3, 0];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ data: totals.shift() });
  };
  try {
    const service = new HttpDataService();
    assert.equal(await service.queryOpenAlertCount(), 3);
    assert.equal(await service.queryOpenAlertCount(), 0);
    for (const call of calls) {
      assert.equal(new URL(call.url, "http://localhost").searchParams.get("resource"), "openAlertCount");
      assert.equal(call.init?.cache, "no-store");
    }
    globalThis.fetch = async () => Response.json({ error: "Alerts temporarily unavailable" }, { status: 503 });
    await assert.rejects(service.queryOpenAlertCount(), { message: "Alerts temporarily unavailable", status: 503 });
  } finally { globalThis.fetch = original; }
});

test("legacy Main Entrance checkpoints collapse into two canonical choices without losing mode", () => {
  const checkpoints = normalizeFacilityCheckpoints([
    { id: "main-gate", name: "Main Entrance", zone: "public", mode: "auto" },
    { id: "server-room", name: "Server Room", zone: "secure", mode: "manual" },
    { id: "cp-main", name: "Main Entrance", zone: "Main Entrance", mode: "manual" },
    { id: "old-lab", name: "IT Lab", zone: "IT Lab" },
  ]);
  assert.deepEqual(checkpoints.map((item) => [item.id, item.name, item.zone]), [
    ["cp-main", "Main Entrance", "public"], ["server-room", "Server Room", "secure"],
  ]);
  assert.equal(checkpoints[0].mode, "manual");
  assert.deepEqual(normalizeFacilityCheckpoints(checkpoints), checkpoints);
  assert.equal(FACILITY_ZONES.length, 2);
  const event = normalizeDashboardMovement({ id: "old", checkpoint_id: "main-gate", data: { checkpoint: "Main Entrance" } });
  assert.equal(event.checkpointId, "cp-main");
});

test("zone aliases normalize across snapshots and live updates without creating extra zones", () => {
  assert.deepEqual(normalizeFacilityZones(["Main Entrance", "public", "Server Room", "secure"]), ["public", "secure"]);
  assert.deepEqual(normalizeFacilityZones(["All Zones"]), ["public", "secure"]);
  assert.deepEqual(normalizeFacilityZones(["IT Lab", 42, null]), []);
  assert.equal(formatFacilityZones(["public", "secure"]), "Main Entrance / Server Room");
  const snapshot = normalizeTerminalSnapshot({ subjects: [{ id: "p1", type: "employee", allowedZones: ["All Zones"] }] });
  assert.deepEqual(snapshot.people[0].allowedZones, ["public", "secure"]);
  const initial: DataState = { ...emptyData, isLoading: false, error: null };
  const received = applyPresenceUpdate(initial, {
    people: snapshot.people,
    request: normalizePermissionRequest({ id: "r1", type: "visitor", checkpointId: "main-gate", requestedZones: ["Main Entrance"] }),
  });
  assert.equal(received.permissionRequests[0].checkpointId, "cp-main");
  assert.deepEqual(received.permissionRequests[0].requestedZones, ["public"]);
});

test("terminal snapshots expose only the assigned checkpoint and preserve an unassigned account", () => {
  const checkpoints = [
    { id: "cp-main", name: "Main Entrance", zone: "public" },
    { id: "server-room", name: "Server Room", zone: "secure" },
  ];
  const assigned = normalizeTerminalSnapshot({ checkpoints, terminalAssignment: { operatorSubject: "operator", checkpointId: "server-room" } });
  assert.deepEqual(assigned.checkpoints.map(checkpoint => checkpoint.id), ["server-room"]);
  assert.equal(assigned.terminalAssignment?.operatorSubject, "operator");
  const unassigned = normalizeTerminalSnapshot({ checkpoints, terminalAssignment: { operatorSubject: "other", checkpointId: null } });
  assert.deepEqual(unassigned.checkpoints, []);
  assert.deepEqual(unassigned.terminalAssignment, { operatorSubject: "other", checkpointId: null });
});
