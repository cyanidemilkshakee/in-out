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
import type { Alert, DashboardAnalytics, MovementEvent } from "../../../lib/types";
import { getAggregateDrillDownData, getDrillDownData, getDashboardKPIs } from "../../../lib/analyticsUtils";
import { dashboardMovementLogHref } from "../../../lib/analyticsQueries";
import { createRefreshScheduler } from "../../../lib/refreshScheduler";
import {
  dashboardRangeBounds,
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
  const { queryDashboardAnalytics } = useDataActions();
  const [timeRange, setTimeRange] = useState<DashboardTimeRange>("Today");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [subjectTypeFilter, setSubjectTypeFilter] = useState<"people" | "hardware">("people");
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");
  const [queryRevision, setQueryRevision] = useState(0);
  const displayedFilters = useRef("");
  const sourceSnapshot = useRef({ movements, alerts });
  const activeRead = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const refreshScheduler = useMemo(() => createRefreshScheduler(
    () => {
      if (activeRead.current) refreshPending.current = true;
      else setQueryRevision(revision => revision + 1);
    }
  ), []);
  const theme = useAdminTheme();
  const themeColors = useMemo(
    () =>
      theme === "dark"
        ? { border: "#0f1413", muted: "#aab8b3" }
        : { border: "#f7faf9", muted: "#52605d" },
    [theme]
  );

  useEffect(() => {
    const reload = () => refreshScheduler.request();
    window.addEventListener("inout:presence-sync", reload);
    return () => {
      window.removeEventListener("inout:presence-sync", reload);
      refreshScheduler.cancel();
    };
  }, [refreshScheduler]);

  useEffect(() => {
    if (sourceSnapshot.current.movements === movements && sourceSnapshot.current.alerts === alerts) return;
    sourceSnapshot.current = { movements, alerts };
    refreshScheduler.request();
  }, [movements, alerts, refreshScheduler]);

  useEffect(() => {
    const { start, end } = dashboardRangeBounds(
      timeRange,
      startDate,
      endDate
    );
    const rangeQuery = {
      ...(Number.isFinite(start) ? { startAt: new Date(start).toISOString() } : {}),
      ...(Number.isFinite(end) ? { endAt: new Date(end).toISOString() } : {}),
    };
    const controller = new AbortController();
    activeRead.current = controller;
    refreshPending.current = false;
    refreshScheduler.cancel();
    setAnalyticsLoading(true);
    setAnalyticsError("");
    const filters = JSON.stringify([subjectTypeFilter, timeRange, startDate, endDate]);
    if (displayedFilters.current !== filters) {
      displayedFilters.current = filters;
      setAnalytics(null);
    }
    void queryDashboardAnalytics({
      subjectGroup: subjectTypeFilter,
      ...rangeQuery,
    }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setAnalytics(result);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setAnalyticsError("Unable to load dashboard totals."); })
      .finally(() => {
        if (controller.signal.aborted) return;
        activeRead.current = null;
        setAnalyticsLoading(false);
        if (refreshPending.current) {
          refreshPending.current = false;
          refreshScheduler.request();
        }
      });
    return () => {
      controller.abort();
      if (activeRead.current === controller) activeRead.current = null;
    };
  }, [
    endDate,
    queryDashboardAnalytics,
    startDate,
    subjectTypeFilter,
    timeRange,
    queryRevision,
    refreshScheduler,
  ]);

  function openMovementLogs(params: Record<string, string>) {
    if (analytics) router.push(dashboardMovementLogHref(subjectTypeFilter, analytics, params));
  }

  function openMetricLogs(metric: "scans" | "alerts" | "approved" | "denied") {
    if (metric === "alerts") {
      const query = new URLSearchParams({ tab: "alerts" });
      if (analytics?.endAt) query.set("endAt", analytics.endAt);
      if (analytics?.startAt) query.set("startAt", analytics.startAt);
      router.push(`/admin/logs?${query}`);
      return;
    }
    const filters: Record<string, string> = metric === "approved" || metric === "denied"
      ? { result: metric }
      : {};
    if (analytics) {
      openMovementLogs(filters);
      return;
    }
    router.push(`/admin/logs?${new URLSearchParams({ subject: subjectTypeFilter, ...filters })}`);
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
      restrictedAuto: { result: "denied", scanType: "auto", denialCategory: "restricted" },
      restrictedManual: { result: "denied", scanType: "manual", denialCategory: "restricted" },
      otherAuto: { result: "denied", scanType: "auto", denialCategory: "other" },
      otherManual: { result: "denied", scanType: "manual", denialCategory: "other" },
    };
    openMovementLogs(queryByNode[nodeId] ?? {});
  }

  const activeScanAnalytics = analytics?.current.scanAnalytics ?? getDashboardKPIs([]);
  const drillDownData = useMemo(() => analytics
    ? getAggregateDrillDownData(analytics.current) : getDrillDownData([]), [analytics]);

  const sharedPlugins = useMemo(() => ({
    legend: {
      labels: {
        boxHeight: 9,
        boxWidth: 9,
        color: themeColors.muted,
        font: { ...chartFont, size: 15, weight: 700 }
      }
    },
    tooltip: {
      backgroundColor: "#000000",
      bodyFont: { ...chartFont, size: 15 },
      cornerRadius: 8,
      displayColors: false,
      titleFont: { ...chartFont, size: 15, weight: 800 }
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
    <section className="dashboard-analytics" aria-label="Dashboard analytics" aria-busy={analyticsLoading}>
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
        current={analytics?.current ?? null}
        previous={analytics?.previous ?? null}
        loading={analyticsLoading}
        onSelect={openMetricLogs}
      />
      {analyticsError ? <p role="status">{analyticsError} <button type="button" className="admin-button" onClick={() => setQueryRevision(revision => revision + 1)}>Retry</button></p> : null}

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

        <div className="vertical-pill-segmented-group" role="group" aria-label="Filter scan breakdown by subject type">
          <button
            type="button"
            className={`icon-filter-button ${subjectTypeFilter === "people" ? "active" : ""}`}
            aria-label="Show people scans"
            aria-pressed={subjectTypeFilter === "people"}
            onClick={() => setSubjectTypeFilter("people")}
            title="People"
          >
            <UsersRound size={18} strokeWidth={subjectTypeFilter === "people" ? 1.6 : 1.2} />
            <span className="dashboard-subject-filter-label">People</span>
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
            <span className="dashboard-subject-filter-label">Hardware</span>
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
                denialCategory: ["restricted", "other"][elements[0].index],
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
        aria-label="Scroll to recent logs"
        onClick={() => {
          const tableHeader = Array.from(document.querySelectorAll('h2')).find(h => h.textContent === 'Recent Logs');
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
