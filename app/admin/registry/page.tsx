"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { EmployeeTable } from "../../../components/admin/tables/EmployeeTable";
import { EmployeeCreator } from "../../../components/admin/tables/EmployeeCreator";
import { PeopleTable } from "../../../components/admin/tables/PeopleTable";
import { HardwareTable } from "../../../components/admin/tables/HardwareTable";
import { HardwareCreator } from "../../../components/admin/tables/HardwareCreator";
import { AlertHistoryTable, PermissionHistoryTable } from "../../../components/admin/registry/RegistryLogTables";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import { Download } from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";

type RegistryTab = "employees" | "visitors" | "hardware" | "alerts" | "permissions";

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

export default function RegistryPage() {
  const { people: staff, hardwareAssets: assets, alerts, auditEvents } = useDataState();
  const { createEmployee, createHardwareAsset, updatePerson, updateHardwareAsset } = useDataActions();
  const [activeTab, setActiveTab] = useState<RegistryTab>("employees");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

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
  let chartProps = { title: "Working hours", valueLabel: "AVG WORKING HOURS", color: "#ea580c", seed: 18, unit: "h" };

  if (activeTab === "visitors") {
    frameTitle = "Visitor Access";
    frameDesc = "Issue temporary passes, inspect host approvals, and keep visitor identities aligned.";
    frameMetric = `${preApprovedCount} pre-approved`;
    chartProps = { title: "Visitors", valueLabel: "AVG VISITORS", color: "#db2777", seed: 24, unit: "" };
  } else if (activeTab === "hardware") {
    frameTitle = "Hardware Custody";
    frameDesc = "Track restricted exits, owner departments, and physical assets moving through checkpoints.";
    frameMetric = `${restrictedCount} restricted`;
    chartProps = { title: "Hardware scans", valueLabel: "AVG HARDWARE ACTIVITY", color: "#8b5cf6", seed: 42, unit: "" };
  } else if (activeTab === "alerts") {
    frameTitle = "Alert History";
    frameDesc = "Review raised, acknowledged, and resolved security alerts as an immutable operational record.";
    frameMetric = `${resolvedAlertCount}/${alerts.length} resolved`;
    chartProps = { title: "Alert history", valueLabel: "RECORDED ALERTS", color: "#ef4444", seed: 31, unit: "" };
  } else if (activeTab === "permissions") {
    frameTitle = "Permission History";
    frameDesc = "Audit manual permissions granted or denied, including the actor, reason, and related record.";
    frameMetric = `${grantedPermissionCount} granted`;
    chartProps = { title: "Permission decisions", valueLabel: "RECORDED DECISIONS", color: "#10b981", seed: 35, unit: "" };
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
          seed={chartProps.seed}
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
            
            <button className="ghost-button" type="button">
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
          
          {activeTab === "employees" && <EmployeeTable people={employees} />}
          {activeTab === "visitors" && <PeopleTable title="Visitors" people={visitors} onToggleInside={(id) => handleToggleInside(id, "person")} />}
          {activeTab === "hardware" && <HardwareTable assets={filteredAssets} onToggleInside={(id) => handleToggleInside(id, "hardware")} />}
          {activeTab === "alerts" && <AlertHistoryTable alerts={alertLogs} />}
          {activeTab === "permissions" && <PermissionHistoryTable events={permissionLogs} />}
        </div>
      </section>
    </AdminPageFrame>
  );
}
