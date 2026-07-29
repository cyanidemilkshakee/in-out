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
const AlertHistoryTable = dynamic(
  () =>
    import("../../../frontend/components/admin/registry/RegistryLogTables").then(
      (module) => module.AlertHistoryTable
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

type RegistryTab = "employees" | "visitors" | "hardware" | "alerts" | "permissions";
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
  { id: "alerts", label: "Alerts" },
  { id: "permissions", label: "Permissions" },
];

function alertTimestamp(createdAt: string | undefined, date: string, time: string) {
  const value = createdAt ? new Date(createdAt).getTime() : new Date(`${date} ${time}`).getTime();
  return Number.isFinite(value) ? value : 0;
}

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
    alerts,
    auditEvents,
  } = useDataState();
  const { createEmployee, createHardwareAsset, updatePerson, updateHardwareAsset } = useDataActions();
  const [activeTab, setActiveTab] = useState<RegistryTab>("employees");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const sessionsByPerson = useMemo(
    () => getPersonSessionIndex(movements),
    [movements]
  );

  function handleToggleInside(id: string, type: "person" | "hardware") {
    if (type === "person") {
      const person = staff.find((item) => item.id === id);
      if (person) void updatePerson(id, { inside: !person.inside });
    } else {
      const asset = assets.find((item) => item.id === id);
      if (asset) void updateHardwareAsset(id, { inside: !asset.inside });
    }
  }

  // Filter Employees
  const employees = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return staff.filter(
      (person) =>
        person.type === "employee" &&
        (!needle || person.name.toLowerCase().includes(needle) || person.barcode.toLowerCase().includes(needle))
    );
  }, [deferredSearch, staff]);
  const insideEmployees = useMemo(() => employees.reduce((count, person) => count + (person.inside ? 1 : 0), 0), [employees]);

  // Filter Visitors
  const visitors = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return staff.filter(
      (person) =>
        person.type === "visitor" &&
        (!needle || person.name.toLowerCase().includes(needle) || person.barcode.toLowerCase().includes(needle))
    );
  }, [deferredSearch, staff]);
  const preApprovedCount = useMemo(() => visitors.reduce((count, person) => count + (person.status === "pre_approved" ? 1 : 0), 0), [visitors]);

  // Filter Hardware
  const filteredAssets = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return assets.filter(
      (asset) =>
        !needle || asset.name.toLowerCase().includes(needle) || asset.barcode.toLowerCase().includes(needle) || asset.owner.toLowerCase().includes(needle)
    );
  }, [assets, deferredSearch]);
  const restrictedCount = useMemo(() => assets.reduce((count, asset) => count + (asset.status === "restricted" ? 1 : 0), 0), [assets]);

  const alertLogs = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return alerts
      .filter((alert) =>
        !needle ||
        alert.title.toLowerCase().includes(needle) ||
        alert.subjectName.toLowerCase().includes(needle) ||
        alert.checkpoint.toLowerCase().includes(needle) ||
        alert.reason.toLowerCase().includes(needle) ||
        alert.status.toLowerCase().includes(needle)
      )
      .sort((left, right) => alertTimestamp(right.createdAt, right.date, right.time) - alertTimestamp(left.createdAt, left.date, left.time));
  }, [alerts, deferredSearch]);
  const resolvedAlertCount = useMemo(
    () => alerts.reduce((count, alert) => count + (alert.status === "resolved" ? 1 : 0), 0),
    [alerts]
  );

  const permissionLogs = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return auditEvents
      .filter((event) =>
        event.category === "permission" &&
        (!needle ||
          event.subjectName.toLowerCase().includes(needle) ||
          event.action.toLowerCase().includes(needle) ||
          event.actor.toLowerCase().includes(needle) ||
          event.reason.toLowerCase().includes(needle) ||
          event.decision?.toLowerCase().includes(needle))
      )
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }, [auditEvents, deferredSearch]);
  const grantedPermissionCount = useMemo(
    () => auditEvents.reduce((count, event) => count + (event.category === "permission" && event.decision === "granted" ? 1 : 0), 0),
    [auditEvents]
  );

  let frameTitle = "Employee Directory";
  let frameDesc = "Manage employee presence, role-linked access, and checkpoint identity records.";
  let frameMetric = `${insideEmployees}/${employees.length} on-site`;
  let chartProps: RegistryChartProps = {
    title: "Working hours",
    valueLabel: "AVG WORKING HOURS",
    color: "#ea580c",
    unit: "h",
    aggregation: "average",
  };

  if (activeTab === "visitors") {
    frameTitle = "Visitor Access";
    frameDesc = "Issue temporary passes, inspect host approvals, and keep visitor identities aligned.";
    frameMetric = `${preApprovedCount} pre-approved`;
    chartProps = { title: "Visitor movements", valueLabel: "VISITOR MOVEMENTS", color: "#db2777", unit: "", aggregation: "sum" };
  } else if (activeTab === "hardware") {
    frameTitle = "Hardware Custody";
    frameDesc = "Track restricted exits, owner departments, and physical assets moving through checkpoints.";
    frameMetric = `${restrictedCount} restricted`;
    chartProps = { title: "Hardware scans", valueLabel: "HARDWARE SCANS", color: "#8b5cf6", unit: "", aggregation: "sum" };
  } else if (activeTab === "alerts") {
    frameTitle = "Alert History";
    frameDesc = "Review raised, acknowledged, and resolved security alerts as an immutable operational record.";
    frameMetric = `${resolvedAlertCount}/${alerts.length} resolved`;
    chartProps = { title: "Alert history", valueLabel: "RECORDED ALERTS", color: "#ef4444", unit: "", aggregation: "sum" };
  } else if (activeTab === "permissions") {
    frameTitle = "Permission History";
    frameDesc = "Audit manual permissions granted or denied, including the actor, reason, and related record.";
    frameMetric = `${grantedPermissionCount} granted`;
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
        .map((movement) => ({
          timestamp: new Date(eventTimestamp(movement)).toISOString(),
          value: 1,
        }));
    }
    if (activeTab === "alerts") {
      return alerts.flatMap((alert) => {
        const timestamp = alertTimestamp(alert.createdAt, alert.date, alert.time);
        return timestamp ? [{ timestamp: new Date(timestamp).toISOString(), value: 1 }] : [];
      });
    }
    return auditEvents
      .filter((event) => event.category === "permission")
      .map((event) => ({ timestamp: event.createdAt, value: 1 }));
  }, [activeTab, alerts, auditEvents, movements, sessionsByPerson]);

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
            : activeTab === "alerts"
              ? alertLogs.map((alert) => ({
                  date: alert.date,
                  time: alert.time,
                  title: alert.title,
                  subject: alert.subjectName,
                  barcode: alert.barcode,
                  severity: alert.severity,
                  checkpoint: alert.checkpoint,
                  reason: alert.reason,
                  status: alert.status,
                  reference: alert.id,
                }))
              : permissionLogs.map((event) => ({
                  date: event.date,
                  time: event.time,
                  subject: event.subjectName,
                  action: event.action,
                  decision: event.decision,
                  actor: event.actor,
                  role: event.role,
                  reason: event.reason,
                  reference: event.relatedId,
                }));
    downloadCsv(`inout-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  return (
    <AdminPageFrame
      title={frameTitle}
      description={frameDesc}
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
        <div className="workspace-main">
          <div className="filter-bar">
            {activeTab !== "employees" && (
              <label className="select-control">
                <span className="sr-only">Filter by time</span>
                <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)}>
                  <option value="1Y">Last 1 Year</option>
                  <option value="1M">Last 1 Month</option>
                  <option value="1W">Last 1 Week</option>
                  <option value="1D">Last 24 Hours</option>
                </select>
              </label>
            )}
            
            {activeTab === "employees" && <EmployeeCreator onCreate={createEmployee} />}
            {activeTab === "hardware" && <HardwareCreator onCreate={createHardwareAsset} />}
            
            <button
              className="ghost-button"
              type="button"
              onClick={handleExport}
              disabled={
                (activeTab === "employees" && employees.length === 0) ||
                (activeTab === "visitors" && visitors.length === 0) ||
                (activeTab === "hardware" && filteredAssets.length === 0) ||
                (activeTab === "alerts" && alertLogs.length === 0) ||
                (activeTab === "permissions" && permissionLogs.length === 0)
              }
            >
              <Download />
              Export
            </button>
            <label className="search-control" style={{ marginLeft: "auto" }}>
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
          {activeTab === "visitors" && <PeopleTable title="Visitors" people={visitors} onToggleInside={(id) => handleToggleInside(id, "person")} />}
          {activeTab === "hardware" && <HardwareTable assets={filteredAssets} onToggleInside={(id) => handleToggleInside(id, "hardware")} />}
          {activeTab === "alerts" && <AlertHistoryTable alerts={alertLogs} />}
          {activeTab === "permissions" && <PermissionHistoryTable events={permissionLogs} />}
        </div>
      </section>
    </AdminPageFrame>
  );
}
