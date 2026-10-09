"use client";

import dynamic from "next/dynamic";
import { Suspense, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { EmployeeTable } from "../../../frontend/components/admin/tables/EmployeeTable";
import { EmployeeCreator } from "../../../frontend/components/admin/tables/EmployeeCreator";
import { HardwareCreator } from "../../../frontend/components/admin/tables/HardwareCreator";
import type { MetricTrendPoint } from "../../../frontend/components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../frontend/components/analytics/TrendChart";
import { Download } from "lucide-react";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import { getPersonSessionIndex } from "../../../lib/analyticsUtils";
import { eventTimestamp } from "../../../lib/dateRanges";

const PeopleTable = dynamic(
  () =>
    import("../../../frontend/components/admin/tables/PeopleTable").then(
      (module) => module.PeopleTable
    )
);
const HardwareTable = dynamic(
  () =>
    import("../../../frontend/components/admin/tables/HardwareTable").then(
      (module) => module.HardwareTable
    )
);
const MetricTrendChart = dynamic(
  () =>
    import("../../../frontend/components/analytics/MetricTrendChart").then(
      (module) => module.MetricTrendChart
    ),
  { ssr: false }
);

type RegistryTab = "employees" | "visitors" | "hardware";
type RegistryChartProps = {
  title: string;
  valueLabel: string;
  color: string;
  unit: string;
  aggregation: "sum" | "average";
};

const REGISTRY_TABS: Array<{ id: RegistryTab; label: string }> = [
  { id: "employees", label: "Employees" },
  { id: "visitors", label: "Visitors" },
  { id: "hardware", label: "Hardware" },
];

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function RegistryWorkspace() {
  const {
    people: staff,
    hardwareAssets: assets,
    movements,
    permissions,
    alerts,
  } = useDataState();
  const { createEmployee, createHardwareAsset } = useDataActions();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<RegistryTab>("employees");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "permissions" || tab === "alerts") {
      const query = new URLSearchParams(searchParams.toString());
      router.replace(`/admin/logs?${query.toString()}`);
      return;
    }
    if (tab === "employees" || tab === "visitors" || tab === "hardware") setActiveTab(tab);
  }, [router, searchParams]);
  const deferredSearch = useDeferredValue(search);
  const sessionsByPerson = useMemo(
    () => getPersonSessionIndex(movements),
    [movements]
  );

  // Filter Employees
  const allEmployees = useMemo(
    () => staff.filter((person) => person.type === "employee"),
    [staff]
  );
  const employees = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return allEmployees.filter(
      (person) =>
        (!needle || person.name.toLowerCase().includes(needle) || person.barcode.toLowerCase().includes(needle))
    );
  }, [allEmployees, deferredSearch]);
  const insideEmployees = useMemo(() => allEmployees.reduce((count, person) => count + (person.inside ? 1 : 0), 0), [allEmployees]);

  // Filter Visitors
  const allVisitors = useMemo(
    () => staff.filter((person) => person.type === "visitor"),
    [staff]
  );
  const visitors = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return allVisitors.filter(
      (person) =>
        (!needle || [person.name, person.barcode, person.host, person.company].some((value) => value?.toLowerCase().includes(needle)))
    );
  }, [allVisitors, deferredSearch]);
  const preApprovedCount = useMemo(() => allVisitors.reduce((count, person) => count + (person.status === "pre_approved" ? 1 : 0), 0), [allVisitors]);
  const pendingVisitorCount = useMemo(() => allVisitors.filter((person) => person.status === "pending_approval").length, [allVisitors]);

  // Filter Hardware
  const filteredAssets = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return assets.filter(
      (asset) =>
        !needle || asset.name.toLowerCase().includes(needle) || asset.barcode.toLowerCase().includes(needle) || asset.owner.toLowerCase().includes(needle)
    );
  }, [assets, deferredSearch]);
  const restrictedCount = useMemo(() => assets.reduce((count, asset) => count + (asset.status === "restricted" ? 1 : 0), 0), [assets]);
  let frameMetric = `${insideEmployees}/${allEmployees.length} on-site`;
  let chartProps: RegistryChartProps = {
    title: "Working hours",
    valueLabel: "AVG WORKING HOURS",
    color: "#ea580c",
    unit: "h",
    aggregation: "average",
  };

  if (activeTab === "visitors") {
    frameMetric = `${pendingVisitorCount} pending · ${preApprovedCount} pre-approved`;
    chartProps = { title: "Visitor movements", valueLabel: "VISITOR MOVEMENTS", color: "#db2777", unit: "", aggregation: "sum" };
  } else if (activeTab === "hardware") {
    frameMetric = `${restrictedCount} restricted`;
    chartProps = { title: "Hardware scans", valueLabel: "HARDWARE SCANS", color: "#8b5cf6", unit: "", aggregation: "sum" };
  }

  const metricPoints = useMemo<MetricTrendPoint[]>(() => {
    if (activeTab === "employees") {
      return [...sessionsByPerson.values()].flatMap((sessions) =>
        sessions.map((session) => ({
            timestamp: session.dateObj.toISOString(),
            value: session.workedHours,
          }))
      );
    }
    if (activeTab === "visitors" || activeTab === "hardware") {
      return movements
        .filter((movement) =>
          activeTab === "visitors"
            ? movement.subjectType === "visitor"
            : movement.subjectType === "hardware"
        )
        .flatMap((movement) => {
          const timestamp = eventTimestamp(movement);
          return timestamp > 0
            ? [{ timestamp: new Date(timestamp).toISOString(), value: 1 }]
            : [];
        });
    }
    return [];
  }, [activeTab, movements, sessionsByPerson]);

  function handleExport() {
    const rows: Array<Record<string, unknown>> = activeTab === "employees"
        ? employees.map((person) => ({
            name: person.name,
            barcode: person.barcode,
            allowedZones: person.allowedZones.join("; "),
            status: person.status,
            inside: person.inside,
            createdAt: person.createdAt,
          }))
        : activeTab === "visitors"
          ? visitors.map((person) => ({
              name: person.name,
              barcode: person.barcode,
              company: person.company,
              host: person.host,
              purpose: person.purpose,
              validFrom: person.validFrom,
              validTo: person.validTo,
              status: person.status,
              inside: person.inside,
            }))
          : filteredAssets.map((asset) => ({
              name: asset.name,
              barcode: asset.barcode,
              owner: asset.owner,
              category: asset.category,
              allowedZones: asset.allowedZones.join("; "),
              status: asset.status,
              inside: asset.inside,
              createdAt: asset.createdAt,
            }));
    downloadCsv(`inout-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  return (
    <AdminPageFrame
      title="Registry"
      metric={frameMetric}
      preTitle={
        <div className="registry-segmented-shell">
          <div className="pill-segmented-group registry-segmented-group" role="tablist" aria-label="Registry data type">
            {REGISTRY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`pill-segmented-button ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => { setActiveTab(tab.id); setSearch(""); }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      }
      headerRight={
        <MetricTrendChart
          title={chartProps.title}
          valueLabel={chartProps.valueLabel}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color={chartProps.color}
          points={metricPoints}
          aggregation={chartProps.aggregation}
          unit={chartProps.unit}
        />
      }
    >
      <section className="registry-workspace">
        <div className="admin-panel workspace-main">
          <div className="filter-bar">
            {activeTab === "employees" && <EmployeeCreator onCreate={createEmployee} />}
            {activeTab === "hardware" && <HardwareCreator onCreate={createHardwareAsset} />}
            
            <button
              className="admin-button admin-button--ghost ghost-button"
              type="button"
              onClick={handleExport}
              disabled={
                (activeTab === "employees" && employees.length === 0) ||
                (activeTab === "visitors" && visitors.length === 0) ||
                (activeTab === "hardware" && filteredAssets.length === 0)
              }
            >
              <Download />
              Export
            </button>
            <label className="search-control registry-search-control">
              <span className="sr-only">Search</span>
              <input
                type="search"
                maxLength={200}
                placeholder={`Search ${REGISTRY_TABS.find((tab) => tab.id === activeTab)?.label.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          
          {activeTab === "employees" && (
            <EmployeeTable
              people={employees}
              movements={movements}
              sessionsByPerson={sessionsByPerson}
              permissions={permissions}
              alerts={alerts}
            />
          )}
          {activeTab === "visitors" && <PeopleTable title="Visitors" people={visitors} />}
          {activeTab === "hardware" && <HardwareTable assets={filteredAssets} />}
        </div>
      </section>
    </AdminPageFrame>
  );
}

export default function RegistryPage() {
  return <Suspense fallback={<p role="status">Loading registry…</p>}><RegistryWorkspace /></Suspense>;
}
