"use client";

import {
  Bell,
  Scan,
  CheckCircle,
  XCircle,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import type { ScanAnalytics, Alert, MovementEvent } from "../../../lib/types";
import {
  dashboardRangeBounds,
  eventTimestamp,
  type DashboardTimeRange,
} from "../../../lib/dateRanges";

type KPICardsProps = {
  alerts: Alert[];
  movements: MovementEvent[];
  allAlerts: Alert[];
  allMovements: MovementEvent[];
  scanAnalytics: ScanAnalytics;
  timeRange: DashboardTimeRange;
  startDate: string;
  endDate: string;
  subjectType: "people" | "hardware";
};

type Comparison = {
  direction: "up" | "down" | "flat";
  percentage: number | null;
};

function comparison(current: number, previous: number): Comparison {
  if (current === previous) return { direction: "flat", percentage: 0 };
  if (previous === 0) {
    return { direction: current > 0 ? "up" : "flat", percentage: null };
  }
  return {
    direction: current > previous ? "up" : "down",
    percentage: Math.round((Math.abs(current - previous) / previous) * 100),
  };
}

function TrendBadge({
  value,
  positiveWhenDown = false,
}: {
  value?: Comparison;
  positiveWhenDown?: boolean;
}) {
  if (!value) {
    return (
      <div className="dashboard-kpi-comparison is-neutral">
        <Minus size={14} />
        <span>All available data</span>
      </div>
    );
  }
  const improving =
    value.direction === "flat" ||
    (positiveWhenDown ? value.direction === "down" : value.direction === "up");
  const Icon =
    value.direction === "up"
      ? TrendingUp
      : value.direction === "down"
        ? TrendingDown
        : Minus;
  return (
    <div
      className={`dashboard-kpi-comparison ${improving ? "is-positive" : "is-negative"}`}
    >
      <Icon size={14} />
      <span>{value.percentage === null ? "New" : `${value.percentage}%`}</span>
      <span className="dashboard-kpi-comparison-label">vs previous period</span>
    </div>
  );
}

export function KPICards({
  alerts,
  movements,
  allAlerts,
  allMovements,
  scanAnalytics,
  timeRange,
  startDate,
  endDate,
  subjectType,
}: KPICardsProps) {
  const bounds = dashboardRangeBounds(timeRange, startDate, endDate);
  const finiteRange =
    Number.isFinite(bounds.start) &&
    Number.isFinite(bounds.end) &&
    bounds.end >= bounds.start;
  const duration = finiteRange ? bounds.end - bounds.start + 1 : 0;
  const previousStart = bounds.start - duration;
  const previousEnd = bounds.start - 1;
  const typeMatches = (movement: MovementEvent) =>
    subjectType === "hardware"
      ? movement.subjectType === "hardware"
      : movement.subjectType === "employee" || movement.subjectType === "visitor";
  const previousMovements = finiteRange
    ? allMovements.filter((movement) => {
        const timestamp = eventTimestamp(movement);
        return (
          typeMatches(movement) &&
          timestamp >= previousStart &&
          timestamp <= previousEnd
        );
      })
    : [];
  const previousAlerts = finiteRange
    ? allAlerts.filter((alert) => {
        const timestamp = new Date(
          alert.createdAt ?? `${alert.date} ${alert.time}`
        ).getTime();
        return timestamp >= previousStart && timestamp <= previousEnd;
      })
    : [];

  const metricCards = [
    {
      label: "Total Scans",
      icon: Scan,
      value: scanAnalytics.totalScans,
      trend: finiteRange
        ? comparison(movements.length, previousMovements.length)
        : undefined,
    },
    {
      label: "Alerts",
      icon: Bell,
      value: alerts.length,
      trend: finiteRange
        ? comparison(alerts.length, previousAlerts.length)
        : undefined,
      positiveWhenDown: true,
    },
    {
      label: "Approved",
      icon: CheckCircle,
      value: scanAnalytics.totalApproved,
      trend: finiteRange
        ? comparison(
            scanAnalytics.totalApproved,
            previousMovements.filter((movement) => movement.result === "approved").length
          )
        : undefined,
    },
    {
      label: "Denied",
      icon: XCircle,
      value: scanAnalytics.totalDenied,
      trend: finiteRange
        ? comparison(
            scanAnalytics.totalDenied,
            previousMovements.filter((movement) => movement.result === "denied").length
          )
        : undefined,
      positiveWhenDown: true,
    },
  ] as const;

  return (
    <div className="dashboard-kpi-grid animate-slide-up delay-100">
      {metricCards.map((card) => {
        const Icon = card.icon;
        return (
          <div className="metric-widget-box dashboard-kpi-card" key={card.label}>
            <div className="dashboard-kpi-label">
              <Icon size={18} />
              <span>{card.label}</span>
            </div>
            <div className="dashboard-kpi-value">{card.value.toLocaleString()}</div>
            <TrendBadge
              value={card.trend}
              positiveWhenDown={"positiveWhenDown" in card && card.positiveWhenDown}
            />
          </div>
        );
      })}
    </div>
  );
}
