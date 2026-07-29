"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { AlertActivity } from "../../../frontend/components/admin/alerts/AlertActivity";
import { AutomatedRules } from "../../../frontend/components/admin/alerts/AutomatedRules";
import type { TimeRange } from "../../../frontend/components/analytics/TrendChart";
import type { Alert } from "../../../lib/types";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import { compactRangeBounds } from "../../../lib/dateRanges";

const MetricTrendChart = dynamic(
  () =>
    import("../../../frontend/components/analytics/MetricTrendChart").then(
      (module) => module.MetricTrendChart
    ),
  { ssr: false }
);

export default function AlertsPage() {
  const { alerts, alertRules } = useDataState();
  const { updateAlert, updateAlertRule } = useDataActions();
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  function handleUpdateAlert(alertId: string, status: Alert["status"]) {
    void updateAlert(alertId, { status });
  }

  const activeAlerts = useMemo(
    () => alerts.filter((alert) => alert.status !== "resolved"),
    [alerts]
  );
  const filteredAlerts = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    const { start, end } = compactRangeBounds(timeRange);
    return activeAlerts.filter((alert) => {
      const timestamp = alert.createdAt
        ? new Date(alert.createdAt).getTime()
        : new Date(`${alert.date} ${alert.time}`).getTime();
      const matchesTime =
        Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
      const matchesSearch =
        !needle ||
        alert.subjectName.toLowerCase().includes(needle) ||
        alert.reason.toLowerCase().includes(needle) ||
        alert.title.toLowerCase().includes(needle) ||
        alert.checkpoint.toLowerCase().includes(needle);
      return matchesTime && matchesSearch;
    });
  }, [activeAlerts, deferredSearch, timeRange]);
  const alertPoints = useMemo(
    () =>
      alerts.flatMap((alert) => {
        const timestamp = alert.createdAt
          ? new Date(alert.createdAt).getTime()
          : new Date(`${alert.date} ${alert.time}`).getTime();
        return Number.isFinite(timestamp)
          ? [{ timestamp: new Date(timestamp).toISOString(), value: 1 }]
          : [];
      }),
    [alerts]
  );

  return (
    <AdminPageFrame
      title="Alert Command"
      description="See every alert in the system for immediate security response."
      metric={`${activeAlerts.length} active alerts`}
      headerRight={
        <MetricTrendChart
          title="Alerts"
          valueLabel="ALERTS IN RANGE"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color="#ff3b30"
          points={alertPoints}
        />
      }
    >
      <section className="alerts-command-stack">
        <div className="filter-bar alerts-filter-bar">
          <label className="select-control">
            <span className="sr-only">Filter by time</span>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            >
              <option value="1Y">Last 1 Year</option>
              <option value="1M">Last 1 Month</option>
              <option value="1W">Last 1 Week</option>
              <option value="1D">Last 24 Hours</option>
            </select>
          </label>
          <label className="search-control" style={{ marginLeft: "auto" }}>
            <span className="sr-only">Search alerts</span>
            <input
              type="search"
              placeholder="Search alerts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="alerts-command-grid">
          <AlertActivity
            alerts={filteredAlerts}
            onUpdate={handleUpdateAlert}
          />
          <AutomatedRules
            rules={alertRules}
            onToggle={(ruleId, enabled) => void updateAlertRule(ruleId, enabled)}
          />
        </div>
      </section>
    </AdminPageFrame>
  );
}
