"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { EmployeeTable } from "../../../frontend/components/admin/tables/EmployeeTable";
import { RegistryCreateDialog } from "../../../frontend/components/admin/tables/RegistryCreateDialog";
import { useDataActions } from "../../../frontend/context/DataContext";
import { employeeActivityPatterns, employeeActivityRangeDays } from "../../../lib/analyticsQueries";
import { assertCsvBound, readExport } from "../../../lib/exportRead";
import { createRefreshScheduler } from "../../../lib/refreshScheduler";
import type { TimeRange } from "../../../lib/dateRanges";
import type { HardwareAsset, Person, RegistryKind, RegistryPage as RegistryPageData, RegistrySortKey, SortDirection } from "../../../lib/types";

const PeopleTable = dynamic(() => import("../../../frontend/components/admin/tables/PeopleTable").then(module => module.PeopleTable));
const HardwareTable = dynamic(() => import("../../../frontend/components/admin/tables/HardwareTable").then(module => module.HardwareTable));
const MetricTrendChart = dynamic(() => import("../../../frontend/components/analytics/MetricTrendChart").then(module => module.MetricTrendChart), { ssr: false });
const REGISTRY_TABS = [
  { id: "employee", label: "Employees", tab: "employees" },
  { id: "visitor", label: "Visitors", tab: "visitors" },
  { id: "hardware", label: "Hardware", tab: "hardware" },
] as const;
const PAGE_SIZE = 25;

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  return `"${(/^[=+\-@]/.test(raw) ? `'${raw}` : raw).replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const csv = [columns.map(csvCell).join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n");
  assertCsvBound(csv);
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function RegistryWorkspace() {
  const { createEmployee, createVisitor, createHardwareAsset, queryRegistryPage } = useDataActions();
  const params = useSearchParams();
  const router = useRouter();
  const initialTab = REGISTRY_TABS.find(tab => tab.tab === params.get("tab"))?.id ?? "employee";
  const [kind, setKind] = useState<RegistryKind>(initialTab);
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<RegistrySortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<RegistryPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const overviewKey = useRef("");
  const activeRead = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const refreshScheduler = useMemo(() => createRefreshScheduler(() => {
    if (activeRead.current) refreshPending.current = true;
    else setRevision(value => value + 1);
  }), []);
  const days = employeeActivityRangeDays(timeRange);
  const tab = REGISTRY_TABS.find(item => item.id === kind)!;

  useEffect(() => {
    if (params.get("tab") === "permissions" || params.get("tab") === "alerts") router.replace(`/admin/logs?${params}`);
  }, [params, router]);
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const reload = () => refreshScheduler.request();
    const receive = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        const movementKind = update.movement?.subjectType ?? update.movement?.subject_type;
        const affected = update.type === "data_changed" || update.type === "snapshot_required" || movementKind === kind
          || (Array.isArray(update.people) && update.people.some((person: Person) => person.type === kind))
          || (kind === "hardware" && Array.isArray(update.hardwareAssets) && update.hardwareAssets.length > 0);
        if (affected) reload();
      } catch { /* A reconnect reconciles malformed events. */ }
    };
    window.addEventListener("inout:presence-message", receive);
    window.addEventListener("inout:presence-sync", reload);
    const restore = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      window.removeEventListener("inout:presence-message", receive);
      window.removeEventListener("inout:presence-sync", reload);
      window.removeEventListener("focus", restore);
      window.removeEventListener("online", restore);
      document.removeEventListener("visibilitychange", restore);
      refreshScheduler.cancel();
    };
  }, [refreshScheduler, kind]);
  useEffect(() => {
    if (search !== debouncedSearch) return;
    const controller = new AbortController();
    activeRead.current = controller;
    refreshPending.current = false;
    refreshScheduler.cancel();
    const key = JSON.stringify([kind, days, revision]);
    const includeOverview = overviewKey.current !== key;
    setLoading(true);
    setError("");
    void queryRegistryPage({ kind, days, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
      search: debouncedSearch.trim() || undefined, sortKey, sortDirection, includeOverview }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (includeOverview) overviewKey.current = key;
        setData(current => includeOverview ? result : { ...result, summary: current?.summary, trend: current?.trend });
        if (Number.isSafeInteger(result.eventRevision)) window.dispatchEvent(new CustomEvent("inout:snapshot-revision", {
          detail: { revision: result.eventRevision, scope: "registry" },
        }));
        if (result.total && result.offset >= result.total) setPage(Math.ceil(result.total / PAGE_SIZE));
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load registry."); })
      .finally(() => {
        if (controller.signal.aborted) return;
        activeRead.current = null;
        setLoading(false);
        if (refreshPending.current) { refreshPending.current = false; refreshScheduler.request(); }
      });
    return () => { controller.abort(); if (activeRead.current === controller) activeRead.current = null; };
  }, [kind, days, page, debouncedSearch, search, sortKey, sortDirection, revision, queryRegistryPage, refreshScheduler]);

  const visible = data?.kind === kind ? data : null;
  const sessionsByPerson = useMemo(() => new Map(Object.entries(visible?.activityDays ?? {}).map(([id, activityDays]) => [id,
    employeeActivityPatterns({ days: activityDays, totalHours: 0, previousTotalHours: 0, startAt: "", endAt: "", previousStartAt: "", previousEndAt: "" }).reverse(),
  ])), [visible?.activityDays]);
  const summary = visible?.summary;
  const frameMetric = kind === "employee" ? `${summary?.inside ?? 0}/${summary?.total ?? 0} on-site`
    : kind === "visitor" ? `${summary?.pending ?? 0} pending · ${summary?.preApproved ?? 0} pre-approved`
    : `${summary?.restricted ?? 0} restricted`;
  const sort = { key: sortKey, direction: sortDirection, onChange: (key: RegistrySortKey) => {
    setSortKey(key); setSortDirection(sortKey === key && sortDirection === "asc" ? "desc" : "asc"); setPage(1);
  } };
  const reload = () => setRevision(value => value + 1);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    exportController.current = controller;
    try {
      const result = await readExport<RegistryPageData>("registry", { kind, days, search: debouncedSearch.trim() || undefined,
        sortKey, sortDirection }, controller.signal);
      const records: Array<Person | HardwareAsset> = kind === "hardware" ? result.hardwareAssets : result.people;
      const averages = result.averages;
      const rows: Array<Record<string, unknown>> = records.map(record => kind === "employee" ? {
        name: record.name, barcode: record.barcode, allowedZones: record.allowedZones.join("; "), status: record.status, inside: record.inside,
        [`avgWorkHoursPerDay_${timeRange}`]: averages[record.id] ?? "", createdAt: record.createdAt,
      } : kind === "visitor" ? {
        name: record.name, barcode: record.barcode, company: "company" in record ? record.company : "", host: "host" in record ? record.host : "",
        purpose: "purpose" in record ? record.purpose : "", validFrom: "validFrom" in record ? record.validFrom : "", validTo: "validTo" in record ? record.validTo : "",
        status: record.status, inside: record.inside,
      } : { name: record.name, barcode: record.barcode, owner: "owner" in record ? record.owner : "", category: "category" in record ? record.category : "",
        allowedZones: record.allowedZones.join("; "), status: record.status, inside: record.inside, createdAt: record.createdAt });
      downloadCsv(`inout-${tab.tab}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to export registry."); }
    finally { clearTimeout(timer); setExporting(false); }
  }

  return <AdminPageFrame title="Registry" metric={frameMetric}
    preTitle={<div className="registry-segmented-shell"><div className="pill-segmented-group registry-segmented-group" role="tablist" aria-label="Registry data type">
      {REGISTRY_TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={kind === item.id}
        className={`pill-segmented-button ${kind === item.id ? "active" : ""}`}
        onClick={() => { setKind(item.id); setPage(1); setSearch(""); setDebouncedSearch(""); setSortKey("name"); setSortDirection("asc"); }}>
        {item.label}</button>)}
    </div></div>}
    headerRight={<MetricTrendChart title={kind === "employee" ? "Working hours" : kind === "visitor" ? "Visitor movements" : "Hardware scans"}
      valueLabel={kind === "employee" ? "AVG WORKING HOURS" : kind === "visitor" ? "VISITOR MOVEMENTS" : "HARDWARE SCANS"}
      timeRange={timeRange} onTimeRangeChange={setTimeRange} color={kind === "employee" ? "#ea580c" : kind === "visitor" ? "#db2777" : "#8b5cf6"}
      points={[]} aggregation={kind === "employee" ? "average" : "sum"} unit={kind === "employee" ? "h" : ""} summary={visible?.trend} />}
  >
    <section className="registry-workspace"><div className="admin-panel workspace-main" aria-busy={loading}>
      <div className="filter-bar">
        <RegistryCreateDialog initialKind={kind} employees={[]} checkpoints={visible?.checkpoints ?? []} searchEmployees
          onCreateEmployee={async input => { const result = await createEmployee(input); reload(); return result; }}
          onCreateVisitor={async input => { const result = await createVisitor(input); reload(); return result; }}
          onCreateHardware={async input => { const result = await createHardwareAsset(input); reload(); return result; }} />
        <button className="admin-button admin-button--ghost ghost-button" type="button" onClick={() => void handleExport()} disabled={exporting || !visible?.total}>
          <Download />{exporting ? "Exporting…" : "Export"}</button>
        <label className="search-control registry-search-control"><span className="sr-only">Search</span>
          <input type="search" maxLength={200} placeholder={`Search ${tab.label.toLowerCase()}...`} value={search} onChange={event => setSearch(event.target.value)} /></label>
      </div>
      {error ? <p className="inline-note" role="alert">{error} <button type="button" onClick={reload}>Retry</button></p> : null}
      {kind === "employee" ? <EmployeeTable people={visible?.people ?? []} movements={visible?.movements ?? []} sessionsByPerson={sessionsByPerson}
        timeRange={timeRange} averageHoursByPerson={visible?.averages ?? null} averageHoursLoading={loading} permissions={[]} alerts={[]} sort={sort} />
        : kind === "visitor" ? <PeopleTable title="Visitors" people={visible?.people ?? []} sort={sort} /> : <HardwareTable assets={visible?.hardwareAssets ?? []} sort={sort} />}
      <div className="pagination"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button>
        <span>Page {page} of {Math.max(1, Math.ceil((visible?.total ?? 0) / PAGE_SIZE))} · {visible?.total ?? 0} records</span>
        <button type="button" disabled={loading || page * PAGE_SIZE >= (visible?.total ?? 0)} onClick={() => setPage(value => value + 1)}>Next</button>
      </div>
    </div></section>
  </AdminPageFrame>;
}

export default function RegistryPage() {
  return <Suspense fallback={<p role="status">Loading registry…</p>}><RegistryWorkspace /></Suspense>;
}
