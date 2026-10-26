import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpDataService } from "../services/httpDataService";
import { comparePeriods, dashboardMovementLogHref, employeeActivityPatterns, employeeHoursSeries, movementAnalyticsFilters } from "../lib/analyticsQueries";
import { getAggregateDrillDownData, getDashboardKPIs } from "../lib/analyticsUtils";
import { createRefreshScheduler } from "../lib/refreshScheduler";
import type { DashboardAnalytics, EmployeeActivity } from "../lib/types";

test("every read query forwards its cancellation signal without adding it to URL filters", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: Array<{ url: URL; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input), "http://test"), signal: init?.signal });
    assert.equal(init?.cache, "no-store");
    return Response.json({ data: {} });
  };
  try {
    const service = new HttpDataService();
    await service.getSnapshot("registry", controller.signal);
    await service.queryOpenAlertCount(controller.signal);
    await service.queryDashboardAnalytics({ subjectGroup: "people" }, controller.signal);
    await service.queryEmployeeActivity({ subjectId: "employee-1", days: 365 }, controller.signal);
    await service.queryEmployeeActivitySummary({ days: 365 }, controller.signal);
    await service.queryMovements({ page: 2, pageSize: 25, includeChart: false }, controller.signal);
    await service.queryAlerts({ limit: 25, offset: 0 }, controller.signal);
    await service.queryAlertRuleAssignments("employee-1", controller.signal);
    await service.queryAuditEvents({ limit: 25, offset: 0 }, controller.signal);
    assert.equal(calls.length, 9);
    for (const call of calls) {
      assert.equal(call.signal, controller.signal);
      assert.equal(call.url.searchParams.has("signal"), false);
    }
    assert.equal(calls[5].url.searchParams.get("includeChart"), "false");
  } finally { globalThis.fetch = originalFetch; }
});

test("superseded reads preserve cancellation both before and after response headers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const afterHeaders of [false, true]) {
      const controller = new AbortController();
      const cancelled = new DOMException("Superseded query", "AbortError");
      const aborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      globalThis.fetch = async (_input, init) => {
        assert.equal(init?.signal, controller.signal);
        if (!afterHeaders) return aborted(controller.signal);
        const response = Response.json({ data: {} });
        response.json = () => aborted(controller.signal);
        return response;
      };
      const pending = new HttpDataService().queryMovements({ page: 1, pageSize: 25 }, controller.signal);
      await Promise.resolve();
      controller.abort(cancelled);
      await assert.rejects(pending, error => error === cancelled);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a scan burst updates display totals once after the last event", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const scheduler = createRefreshScheduler(() => { refreshes++; });
  for (let index = 0; index < 20; index++) {
    scheduler.request();
    context.mock.timers.tick(10);
  }
  assert.equal(refreshes, 0);
  context.mock.timers.tick(190);
  assert.equal(refreshes, 1);
  context.mock.timers.tick(1_000);
  assert.equal(refreshes, 1);
});

test("continuous scanning cannot postpone display totals indefinitely", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const scheduler = createRefreshScheduler(() => { refreshes++; });
  for (let index = 0; index < 20; index++) {
    scheduler.request();
    context.mock.timers.tick(100);
  }
  assert.equal(refreshes, 2);
  context.mock.timers.tick(1_000);
  assert.equal(refreshes, 2);
  scheduler.request();
  context.mock.timers.tick(200);
  assert.equal(refreshes, 3);
});

test("navigation or a direct filter refresh cancels both pending display timers", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const scheduler = createRefreshScheduler(() => { refreshes++; });
  scheduler.request();
  context.mock.timers.tick(150);
  scheduler.request();
  scheduler.cancel();
  context.mock.timers.tick(2_000);
  assert.equal(refreshes, 0);
  scheduler.request();
  context.mock.timers.tick(200);
  assert.equal(refreshes, 1);
});

test("dashboard reads complete counters and prior period without requesting a movement sample", async () => {
  const fetchBefore = global.fetch;
  const complete: DashboardAnalytics = {
    current: { scanAnalytics: { ...getDashboardKPIs([]), totalScans: 1200, totalApproved: 1100 }, alertCount: 20, breakdown: {} },
    previous: { scanAnalytics: { ...getDashboardKPIs([]), totalScans: 1200, totalApproved: 1000 }, alertCount: 10, breakdown: {} },
    startAt: "2026-09-10T00:00:00.000Z", endAt: "2026-09-10T12:00:00.000Z",
    previousStartAt: "2026-09-09T11:59:59.999Z", previousEndAt: "2026-09-09T23:59:59.999Z",
  };
  global.fetch = async (input, init) => {
    const url = new URL(String(input), "http://test");
    assert.equal(url.searchParams.get("resource"), "dashboardAnalytics");
    assert.equal(url.searchParams.get("subjectGroup"), "people");
    assert.equal(url.searchParams.get("startAt"), complete.startAt);
    assert.equal(url.searchParams.get("endAt"), complete.endAt);
    assert.equal(url.searchParams.has("pageSize"), false);
    assert.equal(init?.cache, "no-store");
    return Response.json({ data: complete });
  };
  try {
    const result = await new HttpDataService().queryDashboardAnalytics({ subjectGroup: "people", startAt: complete.startAt!, endAt: complete.endAt });
    assert.deepEqual(result, complete);
    assert.deepEqual(comparePeriods(result.current.scanAnalytics.totalScans, result.previous!.scanAnalytics.totalScans), { direction: "flat", percentage: 0 });
    assert.deepEqual(comparePeriods(result.current.alertCount, result.previous!.alertCount), { direction: "up", percentage: 100 });
  } finally { global.fetch = fetchBefore; }
});

test("dashboard denial categories retain exact dates and include expired passes in Restricted", async () => {
  const bounds = { startAt: "2026-09-09T18:30:00.000Z", endAt: "2026-09-10T07:10:01.123Z" };
  for (const category of ["restricted", "other"] as const) {
    const href = dashboardMovementLogHref("hardware", bounds, { result: "denied", scanType: "manual", denialCategory: category });
    const params = new URL(href, "http://test").searchParams;
    assert.equal(params.get("subject"), "hardware");
    assert.equal(params.get("scanType"), "manual");
    assert.equal(params.has("reason"), false);
    assert.deepEqual(movementAnalyticsFilters(params), { denialCategory: category, ...bounds });
  }
  const lifetime = new URL(dashboardMovementLogHref("people", { startAt: null, endAt: bounds.endAt }, {}), "http://test").searchParams;
  assert.equal(lifetime.has("startAt"), false);
  assert.equal(lifetime.get("endAt"), bounds.endAt);
  assert.deepEqual(movementAnalyticsFilters(new URLSearchParams({ denialCategory: "bad", startAt: "bad" })),
    { denialCategory: undefined, startAt: undefined, endAt: undefined });
});

test("drilldown leaves use complete aggregate counters rather than 500 chart rows", () => {
  const tree = getAggregateDrillDownData({
    scanAnalytics: { ...getDashboardKPIs([]), totalScans: 1200, totalApproved: 200, totalDenied: 1000 },
    alertCount: 0,
    breakdown: { automaticApproved: 150, manualApproved: 50, automaticDenied: 600, manualDenied: 400,
      autoEntry: 100, autoExit: 50, manualEntry: 20, manualExit: 30,
      restrictedAuto: 300, otherAuto: 300, restrictedManual: 150, otherManual: 250 },
  });
  assert.equal(tree.totalScans, 1200);
  assert.equal(tree.sections[1].children[0].children[1].value, 300);
  assert.equal(tree.sections[1].children[1].children[1].value, 250);
  assert.equal(tree.sections[0].children[0].children[0].value, 100);
  assert.equal(tree.sections.reduce((sum, section) => sum + section.value, 0), 1200);
});

test("employee year includes its first partial month and last facility day independent of browser zone", async () => {
  const activity: EmployeeActivity = {
    startAt: "2025-09-30T18:30:00Z", endAt: "2026-09-30T20:00:00Z",
    previousStartAt: "2024-09-30T18:30:00Z", previousEndAt: "2025-09-30T20:00:00Z",
    totalHours: 12, previousTotalHours: 8,
    days: [
      { date: "2025-10-02", workedHours: 3, percentage: 38, sessions: [{ start: 0, end: 3, type: "work", zIndex: 1 }] },
      { date: "2026-10-01", workedHours: 9, percentage: 100, sessions: [{ start: 0, end: 9, type: "work", zIndex: 1 }] },
    ],
  };
  const year = employeeHoursSeries(activity, "1Y");
  assert.equal(year.labels.length, 13);
  assert.equal(year.dataPoints.reduce((sum, hours) => sum + hours, 0), 12);
  const week = employeeHoursSeries(activity, "1W");
  assert.equal(week.labels.at(-1), "1 Oct");
  assert.equal(week.dataPoints.at(-1), 9);
  assert.equal(employeeActivityPatterns(activity)[1].dateObj.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.deepEqual(comparePeriods(activity.totalHours, activity.previousTotalHours), { direction: "up", percentage: 50 });
  assert.deepEqual(comparePeriods(4, 0), { direction: "up", percentage: null });
  assert.deepEqual(comparePeriods(0, 0), { direction: "flat", percentage: 0 });

  const fetchBefore = global.fetch;
  global.fetch = async (input) => {
    const url = new URL(String(input), "http://test");
    assert.equal(url.searchParams.get("resource"), "employeeActivity");
    assert.equal(url.searchParams.get("subjectId"), "employee-1");
    assert.equal(url.searchParams.get("days"), "365");
    return Response.json({ data: activity });
  };
  try { assert.deepEqual(await new HttpDataService().queryEmployeeActivity({ subjectId: "employee-1", days: 365 }), activity); }
  finally { global.fetch = fetchBefore; }
});

test("focused Registry reads keep pagination and search on the server without loading other directories", async () => {
  const previousFetch = global.fetch;
  const calls: URL[] = [];
  const controller = new AbortController();
  global.fetch = async (input, init) => {
    const url = new URL(String(input), "http://test");
    calls.push(url);
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.cache, "no-store");
    return Response.json({ data: { items: [], people: [], hardwareAssets: [], total: 70, limit: 25, offset: 25 } });
  };
  try {
    const service = new HttpDataService();
    await service.queryRegistryPage({ kind: "hardware", limit: 25, offset: 25, days: 30,
      search: "%_literal", sortKey: "owner", sortDirection: "desc", includeOverview: false }, controller.signal);
    await service.queryRegistrySubjects({ kind: "employee", limit: 25, offset: 25, search: "Employee" }, controller.signal);
    await service.querySubjectProfile("subject/with?query", controller.signal);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].searchParams.get("resource"), "registryPage");
    assert.equal(calls[0].searchParams.get("includeOverview"), "false");
    assert.equal(calls[0].searchParams.get("search"), "%_literal");
    assert.equal(calls[0].searchParams.get("offset"), "25");
    assert.equal(calls[0].searchParams.get("sortKey"), "owner");
    assert.equal(calls[1].searchParams.get("resource"), "registrySubjects");
    assert.equal(calls[1].searchParams.get("kind"), "employee");
    assert.equal(calls[2].searchParams.get("resource"), "subjectProfile");
    assert.equal(calls[2].searchParams.get("subjectId"), "subject/with?query");
    assert.equal(calls.every(url => !url.searchParams.has("scope")), true);
  } finally { global.fetch = previousFetch; }
});
