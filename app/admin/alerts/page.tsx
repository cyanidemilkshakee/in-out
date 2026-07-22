"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { AlertActivity } from "../../../components/admin/alerts/AlertActivity";
import { AutomatedRules } from "../../../components/admin/alerts/AutomatedRules";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import type { Alert } from "../../../lib/types";
import { useDataActions, useDataState } from "../../../context/DataContext";

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
    if (!needle) return activeAlerts;
    return activeAlerts.filter(
      (a) =>
        a.subjectName.toLowerCase().includes(needle) ||
        a.reason.toLowerCase().includes(needle) ||
        a.title.toLowerCase().includes(needle) ||
        a.checkpoint.toLowerCase().includes(needle)
    );
  }, [activeAlerts, deferredSearch]);

  return (
    <AdminPageFrame
      title="Alert Command"
      description="See every alert in the system for immediate security response."
      metric={`${activeAlerts.length} active alerts`}
      headerRight={
        <MetricTrendChart
          title="Alerts"
          valueLabel="AVG ALERTS"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          color="#ff3b30"
          seed={31}
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
