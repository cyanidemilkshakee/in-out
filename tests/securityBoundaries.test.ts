import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPathSegment } from "../lib/apiPath";
import { readJsonBody, RequestBodyError } from "../lib/requestJson";
import { collectBoundedPages, CollectionByteBudget, CollectionCapacityError } from "../lib/boundedCollection";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useDataActions } from "../frontend/context/useDataActions";
import { emptyData } from "../frontend/context/dataDefaults";
import { normalizeDashboardMovement, normalizeTerminalSnapshot } from "../lib/normalizeDashboard";
import type { DataActions, DataState } from "../frontend/context/dataTypes";
import type { CreateEmployeeInput, CreateHardwareAssetInput, CreateVisitorInput, DataService, Person, HardwareAsset, PermissionRequest, RecordScanInput, RecordScanResult } from "../lib/types";

test("command identifiers cannot change routes through traversal or encoding", () => {
  for (const value of ["..", ".", "../../keycloak/users/x", "a/b", "a\\b", "%2e%2e", "x?path=y", "x#fragment", "x\nfoo", "a".repeat(201)]) {
    assert.throws(() => recordPathSegment(value));
  }
  assert.equal(recordPathSegment("fixture:record-1"), "fixture%3Arecord-1");
  assert.equal(new URL(`/v1/registry/subjects/${recordPathSegment("fixture:record-1")}`, "https://api.invalid").pathname,
    "/v1/registry/subjects/fixture%3Arecord-1");
});

function bodyRequest(body: ReadableStream<Uint8Array>) {
  return new Request("https://app.invalid/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body,
    duplex: "half" } as RequestInit);
}

test("JSON upload has a total deadline and cancellation cannot hold it open", async () => {
  const previous = process.env.AUTH_URL;
  delete process.env.AUTH_URL;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    cancel() { cancelled = true; return new Promise(() => {}); } });
  try {
    await assert.rejects(readJsonBody(bodyRequest(body), 1024, 20), error => error instanceof RequestBodyError && error.status === 408);
    assert.equal(cancelled, true);
  } finally { if (previous === undefined) delete process.env.AUTH_URL; else process.env.AUTH_URL = previous; }
});

test("streamed JSON limits actual bytes independently of Content-Length", async () => {
  const previous = process.env.AUTH_URL;
  delete process.env.AUTH_URL;
  try {
    const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(65)); c.close(); } });
    await assert.rejects(readJsonBody(bodyRequest(oversized), 64), error => error instanceof RequestBodyError && error.status === 413);
    const valid = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); } });
    assert.deepEqual(await readJsonBody(bodyRequest(valid), 64), { ok: true });
  } finally { if (previous === undefined) delete process.env.AUTH_URL; else process.env.AUTH_URL = previous; }
});

test("bulk collection caps reject excessive totals before more pages and never return partial data", async () => {
  let calls = 0;
  const load = async () => { calls++; return { items: [], total: 11 }; };
  await assert.rejects(collectBoundedPages({ items: [{ id: "first" }], total: 11 }, load, new CollectionByteBudget(), AbortSignal.timeout(1000), 10));
  assert.equal(calls, 0);
  await assert.rejects(collectBoundedPages({ items: [{ id: "first" }], total: 2 }, load, new CollectionByteBudget(), AbortSignal.timeout(1000), 10));
});

test("bulk collection detects repeated offsets and shares a byte budget across pages", async () => {
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(collectBoundedPages({ items: [{ id: "one" }], total: 2 }, async () => ({ items: [{ id: "one" }], total: 2 }), new CollectionByteBudget(), signal));
  await assert.rejects(collectBoundedPages({ items: [{ id: "one" }], total: 2 }, async () => ({ items: [{ id: "two", data: "large".repeat(100) }], total: 2 }), new CollectionByteBudget(100), signal));
  const complete = await collectBoundedPages({ items: [{ id: "one" }], total: 2 }, async offset => {
    assert.equal(offset, 1); return { items: [{ id: "two" }], total: 2 };
  }, new CollectionByteBudget(), signal);
  assert.deepEqual(complete, [{ id: "one" }, { id: "two" }]);
});

test("bulk collection rejects total drift even when pages fill the original total", async () => {
  for (const total of [1, 3, undefined]) {
    await assert.rejects(collectBoundedPages({ items: [{ id: "one" }], total: 2 },
      async () => ({ items: [{ id: "two" }], total }), new CollectionByteBudget(), AbortSignal.timeout(1000)),
      error => error instanceof CollectionCapacityError);
  }
});

test("scan replay receipts do not restore historical presence after the event leaves retained history", async () => {
  const person = normalizeTerminalSnapshot({ subjects: [{ id: "p1", type: "employee", inside: false }] }).people[0];
  const event = normalizeDashboardMovement({ id: "old-entry", subjectId: "p1", subjectType: "employee", result: "approved", direction: "entry", scanType: "auto" });
  const input: RecordScanInput = { barcode: "p1", checkpointId: "main-gate", online: true, scanType: "auto", selectedHardwareIds: [] };
  for (const nestedOnly of [false, true]) {
    const current: DataState = { ...emptyData, isLoading: false, error: null, movements: [], people: [person] };
    let state = current;
    const receipt: RecordScanResult = {
      replayed: !nestedOnly, authorizeMovement: false,
      decision: { replayed: nestedOnly, authorizeMovement: false, event, carriedHardware: [] },
      updatedPeople: [{ ...person, inside: true }], updatedHardwareAssets: [],
    };
    let actions!: DataActions;
    function Harness() {
      actions = useDataActions({ service: { recordScan: async () => receipt } as unknown as DataService,
        setState: update => { state = typeof update === "function" ? update(state) : update; }, refresh: async () => {} });
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    assert.equal(await actions.recordScan(input, "old-retry"), receipt);
    assert.equal(state, current);
    assert.equal(state.people[0].inside, false);
    assert.equal(state.scanAnalytics.totalScans, current.scanAnalytics.totalScans);
  }
});

test("registry creation keeps the committed record visible after a scoped refresh", async () => {
  const employee: Person = { id: "employee-1", name: "Employee", type: "employee", barcode: "E1", allowedZones: [], status: "active", inside: false };
  const visitor: Person = { id: "visitor-1", name: "Visitor", type: "visitor", barcode: "V1", allowedZones: [], status: "pending_approval", inside: false };
  const request: PermissionRequest = { id: "request-1", type: "visitor", subjectId: visitor.id, subjectName: visitor.name, requester: "Admin", purpose: "Visit", requestedZones: [], validFrom: "2026-10-12T00:00:00Z", validTo: "2026-10-12T01:00:00Z", status: "pending", createdAt: "2026-10-12T00:00:00Z" };
  const hardware: HardwareAsset = { id: "hardware-1", name: "Laptop", barcode: "H1", owner: "Employee", category: "Laptop", allowedZones: [], status: "active", inside: false };
  let state: DataState = { ...emptyData, isLoading: false, error: null };
  let refreshCount = 0;
  let actions!: DataActions;
  const service = {
    createEmployee: async (_input: CreateEmployeeInput) => employee,
    createVisitor: async (_input: CreateVisitorInput) => ({ visitor, request }),
    createHardwareAsset: async (_input: CreateHardwareAssetInput) => hardware,
  } as unknown as DataService;
  function Harness() {
    actions = useDataActions({ service, setState: update => {
      state = typeof update === "function" ? update(state) : update;
    }, refresh: async () => {
      refreshCount++;
      // A new scope snapshot can briefly lag behind the just-committed write.
      state = { ...emptyData, isLoading: false, error: null };
    } });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));

  await actions.createEmployee({ name: employee.name, barcode: employee.barcode, status: "active" });
  assert.deepEqual(state.people.map(person => person.id), [employee.id]);
  await actions.createVisitor({ name: visitor.name, barcode: visitor.barcode, host: "Admin", validFrom: request.validFrom, validTo: request.validTo, checkpointId: "cp-main" });
  assert.deepEqual(state.people.map(person => person.id), [visitor.id]);
  assert.deepEqual(state.permissionRequests.map(item => item.id), [request.id]);
  await actions.createHardwareAsset({ name: hardware.name, barcode: hardware.barcode, ownerId: employee.id, category: hardware.category, allowedZone: "public", status: "active" });
  assert.deepEqual(state.hardwareAssets.map(asset => asset.id), [hardware.id]);
  assert.equal(refreshCount, 3);
});
