"use client";

import {
  ArcElement,
  Chart as ChartJS,
  Tooltip,
  Legend,
} from "chart.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Doughnut } from "react-chartjs-2";
import { DrillDownDoughnut } from "./DrillDownDoughnut";
import { KPICards } from "./KPICards";
import { TimeRangeSelector } from "./TimeRangeSelector";
import { PendingDecisionsWidget } from "./PendingDecisionsWidget";
import { UsersRound, Package } from "lucide-react";
import type { Alert, MovementEvent } from "../../../lib/types";
import { getDrillDownData, getDashboardKPIs } from "../../../lib/analyticsUtils";
import {
  dashboardRangeBounds,
  eventTimestamp,
  type DashboardTimeRange,
} from "../../../lib/dateRanges";
import { useAdminTheme } from "../../hooks/useAdminTheme";
import { useDataActions } from "../../context/DataContext";

// Register once at module level — safe because ChartJS handles duplicate registrations
ChartJS.register(ArcElement, Tooltip, Legend);

type DashboardChartsProps = {
  alerts: Alert[];
  movements: MovementEvent[];
  pendingRequests: import("../../../lib/types").PermissionRequest[];
};

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif"
};

const TIME_RANGES = ["Today", "This Week", "This Month", "This Year", "All Time"] as const;

export function DashboardCharts({
  alerts,
  movements,
  pendingRequests,
}: DashboardChartsProps) {
  const router = useRouter();
  const { queryMovements } = useDataActions();
  const [timeRange, setTimeRange] = useState<DashboardTimeRange>("Today");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [subjectTypeFilter, setSubjectTypeFilter] = useState<"people" | "hardware">("people");
  const [availableMovements, setAvailableMovements] = useState(movements);
  const initialRangeQuery = useRef(true);
  const theme = useAdminTheme();
  const themeColors = useMemo(
    () =>
      theme === "dark"
        ? { border: "#0f1413", muted: "#aab8b3" }
        : { border: "#f7faf9", muted: "#52605d" },
    [theme]
  );

  useEffect(() => {
    setAvailableMovements((current) => {
      const currentIds = new Set(current.map((movement) => movement.id));
      const additions = movements.filter(
        (movement) => !currentIds.has(movement.id)
      );
      return additions.length ? [...additions, ...current] : current;
    });
  }, [movements]);

  useEffect(() => {
    if (initialRangeQuery.current) {
      initialRangeQuery.current = false;
      return;
    }
    const { start, end } = dashboardRangeBounds(
      timeRange,
      startDate,
      endDate
    );
    const rangeQuery = {
      ...(Number.isFinite(start) ? { startAt: new Date(start).toISOString() } : {}),
      ...(Number.isFinite(end) ? { endAt: new Date(end).toISOString() } : {}),
    };
    let cancelled = false;
    void queryMovements({
      page: 1,
      pageSize: 200,
      subjectGroup: subjectTypeFilter,
      ...rangeQuery,
      sortKey: "createdAt",
      sortDirection: "desc",
    })
      .then((result) => {
        if (!cancelled) setAvailableMovements(result.chartItems);
      })
      .catch(() => {
        // Keep the already-rendered server snapshot if an on-demand range fails.
      });
    return () => {
      cancelled = true;
    };
  }, [
    endDate,
    queryMovements,
    startDate,
    subjectTypeFilter,
    timeRange,
  ]);

  const filteredMovements = useMemo(() => {
    const { start, end } = dashboardRangeBounds(timeRange, startDate, endDate);
    return availableMovements.filter((movement) => {
      const typeMatches =
        subjectTypeFilter === "people"
          ? movement.subjectType === "employee" || movement.subjectType === "visitor"
          : movement.subjectType === "hardware";
      if (!typeMatches) return false;
      const timestamp = eventTimestamp(movement);
      return Number.isFinite(timestamp) && timestamp > 0 && timestamp >= start && timestamp <= end;
    });
  }, [
    availableMovements,
    endDate,
    startDate,
    subjectTypeFilter,
    timeRange,
  ]);

  const filteredAlerts = useMemo(() => {
    const { start, end } = dashboardRangeBounds(timeRange, startDate, endDate);
    return alerts.filter((alert) => {
      const createdAt = alert.createdAt ? new Date(alert.createdAt).getTime() : NaN;
      const timestamp = Number.isFinite(createdAt)
        ? createdAt
        : new Date(`${alert.date} ${alert.time}`).getTime();
      return Number.isFinite(timestamp) && timestamp > 0 && timestamp >= start && timestamp <= end;
    });
  }, [alerts, endDate, startDate, timeRange]);

  function openMovementLogs(params: Record<string, string>) {
    const query = new URLSearchParams({ subject: subjectTypeFilter, ...params });
    router.push(`/admin/logs?${query.toString()}`);
  }

  function openDrillDown(nodeId: string) {
    const queryByNode: Record<string, Record<string, string>> = {
      approved: { result: "approved" },
      denied: { result: "denied" },
      automaticApproved: { result: "approved", scanType: "auto" },
      manualApproved: { result: "approved", scanType: "manual" },
      automaticDenied: { result: "denied", scanType: "auto" },
      manualDenied: { result: "denied", scanType: "manual" },
      autoEntry: { result: "approved", scanType: "auto", direction: "entry" },
      autoExit: { result: "approved", scanType: "auto", direction: "exit" },
      manualEntry: { result: "approved", scanType: "manual", direction: "entry" },
      manualExit: { result: "approved", scanType: "manual", direction: "exit" },
      restrictedAuto: { result: "denied", scanType: "auto", reason: "restricted" },
      expiredAuto: { result: "denied", scanType: "auto", reason: "expired" },
      restrictedManual: { result: "denied", scanType: "manual", reason: "restricted" },
      expiredManual: { result: "denied", scanType: "manual", reason: "expired" },
      otherAuto: { result: "denied", scanType: "auto" },
      otherManual: { result: "denied", scanType: "manual" },
    };
    openMovementLogs(queryByNode[nodeId] ?? {});
  }

  const activeScanAnalytics = useMemo(() => {
    return getDashboardKPIs(filteredMovements);
  }, [filteredMovements]);

  const drillDownData = useMemo(() => getDrillDownData(filteredMovements), [filteredMovements]);

  const sharedPlugins = useMemo(() => ({
    legend: {
      labels: {
        boxHeight: 9,
        boxWidth: 9,
        color: themeColors.muted,
        font: { ...chartFont, size: 12, weight: 700 }
      }
    },
    tooltip: {
      backgroundColor: "#000000",
      bodyFont: { ...chartFont, size: 12 },
      cornerRadius: 8,
      displayColors: false,
      titleFont: { ...chartFont, size: 12, weight: 800 }
    }
  }), [themeColors]);

  const chartData = useMemo(() => ({
    scanMix: {
      labels: ["Entries", "Exits"],
      datasets: [{
        data: [activeScanAnalytics.totalEntries, activeScanAnalytics.totalExits],
        backgroundColor: ["#12b76a", "#0b63e5"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    autoVsManual: {
      labels: ["Automatic", "Manual"],
      datasets: [{
        data: [activeScanAnalytics.totalAutomatic, activeScanAnalytics.totalManual],
        backgroundColor: ["#0b63e5", "#667085"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    deniedMix: {
      labels: ["Restricted", "Other"],
      datasets: [{
        data: [
          activeScanAnalytics.totalRestricted,
          activeScanAnalytics.totalOtherDenied,
        ],
        backgroundColor: ["#f04438", "#667085"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    quality: {
      labels: ["Approved", "Denied"],
      datasets: [{
        data: [activeScanAnalytics.totalApproved, activeScanAnalytics.totalDenied],
        backgroundColor: ["#12b76a", "#f04438"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
  }), [activeScanAnalytics, themeColors.border]);

  return (
    <section className="dashboard-analytics" aria-label="Dashboard analytics">
      <TimeRangeSelector
        timeRange={timeRange}
        timeRanges={TIME_RANGES}
        onSelect={(range) => {
          setTimeRange(range as DashboardTimeRange);
          setStartDate("");
          setEndDate("");
        }}
        startDate={startDate}
        endDate={endDate}
        onRangeChange={(start, end) => {
          setStartDate(start);
          setEndDate(end);
          if (start || end) setTimeRange("Custom");
        }}
      />

      <KPICards
        alerts={filteredAlerts}
        movements={filteredMovements}
        allAlerts={alerts}
        allMovements={availableMovements}
        scanAnalytics={activeScanAnalytics}
        timeRange={timeRange}
        startDate={startDate}
        endDate={endDate}
        subjectType={subjectTypeFilter}
      />

      {/* Top Left — Scan Status */}
      <div className="analytics-donut dashboard-donut dashboard-donut-quality">
        <div className="dashboard-donut-title">Scan Status</div>
        <Doughnut
          data={chartData.quality}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            onClick: (_, elements) => {
              if (!elements.length) return;
              openMovementLogs({ result: elements[0].index === 0 ? "approved" : "denied" });
            },
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center">
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-approved">
              <span className="dashboard-donut-stat-dot is-approved" />
              Approved
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalApproved.toLocaleString()}</div>
          </div>
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-denied">
              <span className="dashboard-donut-stat-dot is-denied" />
              Denied
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Left — Approved Scans (Entry/Exit) */}
      <div className="analytics-donut dashboard-donut dashboard-donut-approved">
        <div className="dashboard-donut-title">Approved Scans</div>
        <Doughnut
          data={chartData.scanMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            onClick: (_, elements) => {
              if (!elements.length) return;
              openMovementLogs({
                direction: elements[0].index === 0 ? "entry" : "exit",
                result: "approved",
              });
            },
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center">
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-approved">
              <span className="dashboard-donut-stat-dot is-approved" />
              Entries
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalEntries.toLocaleString()}</div>
          </div>
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-blue">
              <span className="dashboard-donut-stat-dot is-blue" />
              Exits
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalExits.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Center — Drill-down Chart */}
      <div className="dashboard-breakdown-cluster">
        <div className="analytics-donut dashboard-breakdown">
          <DrillDownDoughnut data={drillDownData} onNodeClick={openDrillDown} />
          <div className="dashboard-breakdown-title">Total Scan Breakdown</div>
        </div>

        <div className="vertical-pill-segmented-group">
          <button
            type="button"
            className={`icon-filter-button ${subjectTypeFilter === "people" ? "active" : ""}`}
            aria-label="Show people scans"
            aria-pressed={subjectTypeFilter === "people"}
            onClick={() => setSubjectTypeFilter("people")}
            title="People"
          >
            <UsersRound size={18} strokeWidth={subjectTypeFilter === "people" ? 1.6 : 1.2} />
          </button>
          <button
            type="button"
            className={`icon-filter-button ${subjectTypeFilter === "hardware" ? "active" : ""}`}
            aria-label="Show hardware scans"
            aria-pressed={subjectTypeFilter === "hardware"}
            onClick={() => setSubjectTypeFilter("hardware")}
            title="Hardware"
          >
            <Package size={18} strokeWidth={subjectTypeFilter === "hardware" ? 1.6 : 1.2} />
          </button>
        </div>
      </div>

      {/* Center Right — Pending permission decisions */}
      <PendingDecisionsWidget requests={pendingRequests} limit={3} />

      <div className="analytics-donut dashboard-donut dashboard-donut-auto">
        <div className="dashboard-donut-title">Auto vs Manual</div>
        <Doughnut
          data={chartData.autoVsManual}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            onClick: (_, elements) => {
              if (!elements.length) return;
              openMovementLogs({ scanType: elements[0].index === 0 ? "auto" : "manual" });
            },
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center">
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-blue">
              <span className="dashboard-donut-stat-dot is-blue" />
              Auto
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalAutomatic.toLocaleString()}</div>
          </div>
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-muted">
              <span className="dashboard-donut-stat-dot is-muted" />
              Manual
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalManual.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Right — Denied Mix */}
      <div className="analytics-donut dashboard-donut dashboard-donut-denied">
        <div className="dashboard-donut-title">Denied Reasons</div>
        <Doughnut
          data={chartData.deniedMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            onClick: (_, elements) => {
              if (!elements.length) return;
              openMovementLogs({
                result: "denied",
                ...(elements[0].index === 0 ? { reason: "restricted" } : {}),
              });
            },
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center">
          <div className="dashboard-donut-stat-group">
            <div className="dashboard-donut-stat-label is-denied">
              <span className="dashboard-donut-stat-dot is-denied" />
              Restricted
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalRestricted.toLocaleString()}</div>
          </div>
          <div className="dashboard-donut-stat-group is-spaced">
            <div className="dashboard-donut-stat-label is-muted">
              <span className="dashboard-donut-stat-dot is-muted" />
              Other
            </div>
            <div className="dashboard-donut-stat-value">{activeScanAnalytics.totalOtherDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Scroll Indicator */}
      <button
        type="button"
        className="dashboard-scroll-indicator"
        aria-label="Scroll to recent movement logs"
        onClick={() => {
          const tableHeader = Array.from(document.querySelectorAll('h2')).find(h => h.textContent === 'Recent Movement Logs');
          if (tableHeader) {
            tableHeader.scrollIntoView({ behavior: 'smooth' });
          } else {
            const container = document.getElementById("admin-scroll-container");
            if (container) {
              container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
            }
          }
        }}
      >
        <span className="dashboard-scroll-label">
          Scroll
        </span>
        <div className="dashboard-scroll-frame">
          <div className="dashboard-scroll-wheel" />
        </div>
      </button>
    </section>
  );
}
