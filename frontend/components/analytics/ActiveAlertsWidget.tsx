"use client";

import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeTime } from "../../../lib/dateRanges";
import type { Alert } from "../../../lib/types";

type ActiveAlertsWidgetProps = {
  alerts: Alert[];
  limit?: number;
};

const severityLabels: Record<Alert["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
};

export function ActiveAlertsWidget({
  alerts,
  limit = 5,
}: ActiveAlertsWidgetProps) {
  const activeAlerts = useMemo(
    () =>
      alerts
        .filter((alert) => alert.status !== "resolved")
        .toSorted((left, right) => {
          const leftTimestamp = left.createdAt
            ? new Date(left.createdAt).getTime()
            : 0;
          const rightTimestamp = right.createdAt
            ? new Date(right.createdAt).getTime()
            : 0;
          return rightTimestamp - leftTimestamp;
        })
        .slice(0, limit),
    [alerts, limit]
  );

  const activeCount = alerts.reduce(
    (count, alert) => count + (alert.status === "resolved" ? 0 : 1),
    0
  );

  return (
    <section
      className="dashboard-alert-widget alert-widget-box"
      aria-labelledby="active-alerts-heading"
    >
      <header className="alert-widget-header">
        <Link
          className="alert-widget-title-link"
          href="/admin/alerts"
          aria-label="Open active alerts"
        >
          <h2 id="active-alerts-heading">Active Alerts</h2>
          <ChevronRight
            className="alert-widget-title-chevron"
            aria-hidden="true"
            size={18}
          />
        </Link>
      </header>

      {activeAlerts.length > 0 ? (
        <ul className="alert-list-container">
          {activeAlerts.map((alert) => {
            const query = new URLSearchParams({
              result: "denied",
              reason: alert.reason,
            });

            return (
              <li key={alert.id}>
                <Link
                  className="alert-item-card"
                  href={`/admin/logs?${query.toString()}`}
                >
                  <span
                    className={`alert-severity-icon severity-${alert.severity}`}
                    aria-hidden="true"
                  >
                    <AlertTriangle size={17} strokeWidth={1.8} />
                  </span>
                  <span className="alert-item-main">
                    <span className="alert-item-title">{alert.title}</span>
                    <span className="alert-item-meta">
                      <span
                        className={`alert-severity-label severity-${alert.severity}`}
                      >
                        {severityLabels[alert.severity]}
                      </span>
                      <span>{formatRelativeTime(alert.createdAt)}</span>
                      <span className="alert-status-label">
                        {alert.status === "acknowledged"
                          ? "Acknowledged"
                          : "Open"}
                      </span>
                    </span>
                  </span>
                  <ChevronRight
                    className="alert-row-chevron"
                    aria-hidden="true"
                    size={17}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="alert-widget-empty">
          <span className="alert-widget-empty-icon" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>No active alerts</strong>
            <span>All monitored access events are clear.</span>
          </div>
        </div>
      )}

      <p className="alert-widget-count" aria-live="polite">
        {activeCount} active {activeCount === 1 ? "alert" : "alerts"}
      </p>
    </section>
  );
}
