"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useMemo, useState } from "react";
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
const PermissionHistoryTable = dynamic(
  () =>
    import("../../../frontend/components/admin/registry/RegistryLogTables").then(
      (module) => module.PermissionHistoryTable
    )
);
const MetricTrendChart = dynamic(
  () =>
    import("../../../frontend/components/analytics/MetricTrendChart").then(
      (module) => module.MetricTrendChart
    ),
  { ssr: false }
);

type RegistryTab = "employees" | "visitors" | "hardware" | "permissions";
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
  { id: "permissions", label: "Permissions" },
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

export default function RegistryPage() {
  const {
    people: staff,
    hardwareAssets: assets,
    movements,
    permissions,
    auditEvents,
  } = useDataState();
  const { createEmployee, createHardwareAsset } = useDataActions();
  const [activeTab, setActiveTab] = useState<RegistryTab>("employees");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
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
        (!needle || person.name.toLowerCase().includes(needle) || person.barcode.toLowerCase().includes(needle))
    );
  }, [allVisitors, deferredSearch]);
  const preApprovedCount = useMemo(() => allVisitors.reduce((count, person) => count + (person.status === "pre_approved" ? 1 : 0), 0), [allVisitors]);

  // Filter Hardware
  const filteredAssets = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return assets.filter(
      (asset) =>
        !needle || asset.name.toLowerCase().includes(needle) || asset.barcode.toLowerCase().includes(needle) || asset.owner.toLowerCase().includes(needle)
    );
  }, [assets, deferredSearch]);
  const restrictedCount = useMemo(() => assets.reduce((count, asset) => count + (asset.status === "restricted" ? 1 : 0), 0), [assets]);

  const permissionLogs = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    const subjectById = new Map(
      [...staff, ...assets].map((subject) => [subject.id, {
        name: subject.name,
        barcode: subject.barcode,
      }])
    );
    for (const permission of permissions) {
      if (!subjectById.has(permission.subjectId)) {
        subjectById.set(permission.subjectId, {
          name: permission.subjectName,
          barcode: "",
        });
      }
    }

    return auditEvents
      .filter((event) => event.category === "permission")
      .map((event) => {
        const subject = subjectById.get(event.subjectId);
        return {
          ...event,
          subjectName: event.subjectName || subject?.name || "Unregistered barcode",
          barcode: event.barcode || subject?.barcode || "",
        };
      })
      .filter((event) =>
        (!needle ||
          event.subjectName.toLowerCase().includes(needle) ||
          event.barcode.toLowerCase().includes(needle) ||
          event.action.toLowerCase().includes(needle) ||
          event.actor.toLowerCase().includes(needle) ||
          event.reason.toLowerCase().includes(needle) ||
          event.decision?.toLowerCase().includes(needle))
      )
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }, [assets, auditEvents, deferredSearch, permissions, staff]);
  const grantedPermissionCount = useMemo(
    () => auditEvents.reduce((count, event) => count + (event.category === "permission" && event.decision === "granted" ? 1 : 0), 0),
    [auditEvents]
  );

  let frameDescription = "Browse employee identities, access records, and checkpoint activity.";
  let frameMetric = `${insideEmployees}/${allEmployees.length} on-site`;
  let chartProps: RegistryChartProps = {
    title: "Working hours",
    valueLabel: "AVG WORKING HOURS",
    color: "#ea580c",
    unit: "h",
    aggregation: "average",
  };

  if (activeTab === "visitors") {
    frameDescription = "Browse temporary visitor identities and their current access status.";
    frameMetric = `${preApprovedCount} pre-approved`;
    chartProps = { title: "Visitor movements", valueLabel: "VISITOR MOVEMENTS", color: "#db2777", unit: "", aggregation: "sum" };
  } else if (activeTab === "hardware") {
    frameDescription = "Browse registered hardware, custody status, and checkpoint movement.";
    frameMetric = `${restrictedCount} restricted`;
    chartProps = { title: "Hardware scans", valueLabel: "HARDWARE SCANS", color: "#8b5cf6", unit: "", aggregation: "sum" };
  } else if (activeTab === "permissions") {
    frameDescription = "Browse completed access decisions and the review notes behind them.";
    frameMetric = `${grantedPermissionCount} allowed`;
    chartProps = { title: "Permission decisions", valueLabel: "RECORDED DECISIONS", color: "#10b981", unit: "", aggregation: "sum" };
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
    return auditEvents
      .filter((event) => event.category === "permission")
      .map((event) => ({ timestamp: event.createdAt, value: 1 }));
  }, [activeTab, auditEvents, movements, sessionsByPerson]);

  function handleExport() {
    const rows: Array<Record<string, unknown>> =
      activeTab === "employees"
        ? employees.map((person) => ({
            name: person.name,
            barcode: person.barcode,
            department: person.department,
            accessLevel: person.accessLevel,
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
          : activeTab === "hardware"
            ? filteredAssets.map((asset) => ({
                name: asset.name,
                barcode: asset.barcode,
                owner: asset.owner,
                category: asset.category,
                allowedZones: asset.allowedZones.join("; "),
                status: asset.status,
                inside: asset.inside,
                createdAt: asset.createdAt,
              }))
            : permissionLogs.map((event) => ({
                  date: event.date,
                  time: event.time,
                  subject: event.subjectName,
                  barcode: event.barcode,
                  action: event.action,
                  decision: event.decision,
                  actor: event.actor,
                  role: event.role,
                  reason: event.reason,
                }));
    downloadCsv(`inout-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  return (
    <AdminPageFrame
      title="Registry"
      description={frameDescription}
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
                (activeTab === "hardware" && filteredAssets.length === 0) ||
                (activeTab === "permissions" && permissionLogs.length === 0)
              }
            >
              <Download />
              Export
            </button>
            <label className="search-control registry-search-control">
              <span className="sr-only">Search</span>
              <input
                type="search"
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
            />
          )}
          {activeTab === "visitors" && <PeopleTable title="Visitors" people={visitors} />}
          {activeTab === "hardware" && <HardwareTable assets={filteredAssets} />}
          {activeTab === "permissions" && <PermissionHistoryTable events={permissionLogs} />}
        </div>
      </section>
    </AdminPageFrame>
  );
}
