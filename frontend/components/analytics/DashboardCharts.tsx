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
import { ActiveAlertsWidget } from "./ActiveAlertsWidget";
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
};

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif"
};

const TIME_RANGES = ["Today", "This Week", "This Month", "This Year", "All Time"] as const;

export function DashboardCharts({
  alerts,
  movements,
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
    let cancelled = false;
    void queryMovements({
      page: 1,
      pageSize: 100,
      subjectGroup: subjectTypeFilter,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
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
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
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
      const timestamp = alert.createdAt
        ? new Date(alert.createdAt).getTime()
        : new Date(`${alert.date} ${alert.time}`).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
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
        backgroundColor: ["#12b76a", "#027a48"],
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
      labels: ["Restricted", "Expired", "Other"],
      datasets: [{
        data: [
          activeScanAnalytics.totalRestricted,
          activeScanAnalytics.totalExpired,
          activeScanAnalytics.totalOtherDenied,
        ],
        backgroundColor: ["#f04438", "#912018", "#667085"],
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
    <section className="dashboard-analytics" aria-label="Dashboard analytics" style={{
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      display: "grid",
      gridTemplateColumns: "1fr 0.8fr 1fr",
      gridTemplateRows: "1fr 1fr",
      padding: "50px 24px 24px 18px",
      boxSizing: "border-box",
      zIndex: 0
    }}>
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
      <div className="analytics-donut dashboard-donut dashboard-donut-quality animate-slide-up delay-100" style={{ gridColumn: 1, gridRow: 1, alignSelf: "start", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-42px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Scan Status</div>
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
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Approved
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalApproved.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Denied
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Left — Approved Scans (Entry/Exit) */}
      <div className="analytics-donut dashboard-donut dashboard-donut-approved animate-slide-up delay-150" style={{ gridColumn: 1, gridRow: 2, alignSelf: "end", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-42px", marginBottom: "16px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Approved Scans</div>
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
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Entries
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalEntries.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#027a48", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#027a48" }} />
              Exits
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalExits.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Center — Drill-down Chart */}
      <div className="dashboard-breakdown-cluster">
        <div className="analytics-donut dashboard-breakdown" style={{ gridColumn: 2, gridRow: "1 / -1", alignSelf: "center", justifySelf: "center", width: "100%", height: "auto", aspectRatio: "1/1", maxWidth: "1200px", marginTop: "35px" }}>
          <DrillDownDoughnut data={drillDownData} onNodeClick={openDrillDown} />
          <div className="dashboard-breakdown-title" style={{ position: "absolute", top: "calc(100% + 40px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "25px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Total Scan Breakdown</div>
        </div>

        <div className="vertical-pill-segmented-group animate-slide-up delay-100">
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

      {/* Top Right — Auto vs Manual */}
      <ActiveAlertsWidget alerts={alerts} limit={3} />

      <div className="analytics-donut dashboard-donut dashboard-donut-auto animate-slide-up delay-200" style={{ gridColumn: 3, gridRow: 1, alignSelf: "start", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginRight: "-22px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Auto vs Manual</div>
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
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#0b63e5", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0b63e5" }} />
              Auto
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalAutomatic.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
              Manual
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalManual.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Right — Denied Mix */}
      <div className="analytics-donut dashboard-donut dashboard-donut-denied animate-slide-up delay-250" style={{ gridColumn: 3, gridRow: 2, alignSelf: "end", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginRight: "-22px", marginBottom: "16px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Denied Reasons</div>
        <Doughnut
          data={chartData.deniedMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            onClick: (_, elements) => {
              if (!elements.length) return;
              openMovementLogs({
                result: "denied",
                ...(elements[0].index < 2
                  ? { reason: elements[0].index === 0 ? "restricted" : "expired" }
                  : {}),
              });
            },
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Restricted
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalRestricted.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#912018", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#912018" }} />
              Expired
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalExpired.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center", marginTop: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
              Other
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{activeScanAnalytics.totalOtherDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Scroll Indicator */}
      <button
        type="button"
        className="dashboard-scroll-indicator"
        aria-label="Scroll to recent movement logs"
        style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "13px",
          cursor: "pointer",
          zIndex: 10,
          border: 0,
          padding: 0,
          background: "transparent",
          color: "inherit",
        }}
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
        <span style={{
          fontSize: "10px",
          fontWeight: 800,
          letterSpacing: "3px",
          color: "var(--admin-muted)",
          textTransform: "uppercase",
          marginRight: "-3px",
          textAlign: "center"
        }}>
          Scroll
        </span>
        <div style={{
          width: "18px",
          height: "30px",
          border: "2px solid rgba(253, 176, 34, 0.4)",
          borderRadius: "9px",
          display: "flex",
          justifyContent: "center",
          paddingTop: "4px",
          boxSizing: "border-box",
          boxShadow: "0 0 8px rgba(253, 176, 34, 0.2)"
        }}>
          <div className="dashboard-scroll-wheel" style={{
            width: "3px",
            height: "5px",
            backgroundColor: "#d7ddda",
            borderRadius: "1.5px",
            boxShadow: "0 0 4px 1px rgba(253, 176, 34, 0.8)",
            animation: "scrollWheel 1.5s cubic-bezier(0.15, 0.41, 0.69, 0.94) infinite"
          }} />
        </div>
      </button>
    </section>
  );
}
