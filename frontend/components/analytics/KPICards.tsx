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
import type { AnalyticsPeriod } from "../../../lib/types";
import { comparePeriods, type PeriodComparison } from "../../../lib/analyticsQueries";

type KPICardsProps = {
  current: AnalyticsPeriod | null;
  previous: AnalyticsPeriod | null;
  loading: boolean;
  onSelect: (metric: "scans" | "alerts" | "approved" | "denied") => void;
};

function TrendBadge({
  value,
  positiveWhenDown = false,
}: {
  value?: PeriodComparison;
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
  current,
  previous,
  loading,
  onSelect,
}: KPICardsProps) {
  const trend = (value: number | undefined, prior: number | undefined) =>
    value !== undefined && prior !== undefined ? comparePeriods(value, prior) : undefined;
  const metricCards = [
    {
      id: "scans",
      label: "Total Scans",
      icon: Scan,
      value: current?.scanAnalytics.totalScans,
      trend: trend(current?.scanAnalytics.totalScans, previous?.scanAnalytics.totalScans),
    },
    {
      id: "alerts",
      label: "Alerts",
      icon: Bell,
      value: current?.alertCount,
      trend: trend(current?.alertCount, previous?.alertCount),
      positiveWhenDown: true,
    },
    {
      id: "approved",
      label: "Approved",
      icon: CheckCircle,
      value: current?.scanAnalytics.totalApproved,
      trend: trend(current?.scanAnalytics.totalApproved, previous?.scanAnalytics.totalApproved),
    },
    {
      id: "denied",
      label: "Denied",
      icon: XCircle,
      value: current?.scanAnalytics.totalDenied,
      trend: trend(current?.scanAnalytics.totalDenied, previous?.scanAnalytics.totalDenied),
      positiveWhenDown: true,
    },
  ] as const;

  return (
    <div className="dashboard-kpi-grid" aria-busy={loading}>
      {metricCards.map((card) => {
        const Icon = card.icon;
        return (
          <button
            className="metric-widget-box dashboard-kpi-card"
            key={card.label}
            type="button"
            aria-label={`View ${card.id === "alerts" ? "alert" : card.id === "scans" ? "scan" : card.label.toLowerCase()} logs`}
            onClick={() => onSelect(card.id)}
          >
            <div className="dashboard-kpi-label">
              <Icon size={18} />
              <span>{card.label}</span>
            </div>
            <div className="dashboard-kpi-value">{card.value?.toLocaleString() ?? "—"}</div>
            {current ? <TrendBadge
              value={card.trend}
              positiveWhenDown={"positiveWhenDown" in card && card.positiveWhenDown}
            /> : <div className="dashboard-kpi-comparison is-neutral">{loading ? "Loading…" : "Unavailable"}</div>}
          </button>
        );
      })}
    </div>
  );
}
