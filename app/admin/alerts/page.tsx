"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { initialAlerts } from "../../../lib/mockData";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { AlertsView } from "../../../components/admin/tables/AlertsView";
import { MetricTrendChart } from "../../../components/analytics/MetricTrendChart";
import type { TimeRange } from "../../../components/analytics/TrendChart";
import type { Alert } from "../../../lib/types";

export default function AlertsPage() {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  function handleUpdateAlert(alertId: string, status: Alert["status"]) {
    setAlerts((current) =>
      current.map((alert) => (alert.id === alertId ? { ...alert, status } : alert))
    );
  }


  const filteredAlerts = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    if (!needle) return alerts;
    return alerts.filter(
      (a) =>
        a.subjectName.toLowerCase().includes(needle) ||
        a.reason.toLowerCase().includes(needle)
    );
  }, [alerts, deferredSearch]);
  const openAlertCount = useMemo(() => alerts.reduce((count, alert) => count + (alert.status === "open" ? 1 : 0), 0), [alerts]);

  return (
    <AdminPageFrame
      title="Alert Command"
      description="See every alert in the system for immediate security response."
      metric={`${openAlertCount} open alerts`}
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
      <section className="split-workspace log-workspace">
        <div className="workspace-main">
          <div className="filter-bar">
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
          <AlertsView
            alerts={filteredAlerts}
            onUpdate={handleUpdateAlert}
          />
        </div>
      </section>
    </AdminPageFrame>
  );
}
