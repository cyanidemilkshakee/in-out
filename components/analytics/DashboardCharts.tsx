"use client";

import { useEffect, useMemo, useState } from "react";
import { Doughnut } from "react-chartjs-2";
import {
  ArcElement,
  Chart as ChartJS,
  Tooltip,
  Legend,
} from "chart.js";
import { DrillDownDoughnut } from "./DrillDownDoughnut";
import { KPICards } from "./KPICards";
import { TimeRangeSelector } from "./TimeRangeSelector";
import { ActiveAlertsWidget } from "./ActiveAlertsWidget";
import type { Alert, MovementEvent, ScanAnalytics } from "../../lib/types";
import { getDrillDownData } from "../../lib/analyticsUtils";

// Register once at module level — safe because ChartJS handles duplicate registrations
ChartJS.register(ArcElement, Tooltip, Legend);

type DashboardChartsProps = {
  alerts: Alert[];
  movements: MovementEvent[];
  scanAnalytics: ScanAnalytics;
};

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif"
};

const TIME_RANGES = ["Today", "This Week", "This Month", "This Year", "All Time"] as const;

export function DashboardCharts({
  alerts,
  movements,
  scanAnalytics
}: DashboardChartsProps) {
  const [timeRange, setTimeRange] = useState("Today");
  const [themeColors, setThemeColors] = useState({
    border: "#f7faf9",
    muted: "#52605d"
  });

  useEffect(() => {
    const readThemeColors = () => {
      const styles = getComputedStyle(document.documentElement);
      const shell = document.querySelector<HTMLElement>(".role-admin");
      const shellStyles = shell ? getComputedStyle(shell) : styles;
      setThemeColors({
        border: shellStyles.getPropertyValue("--admin-bg").trim() || "#f7faf9",
        muted: shellStyles.getPropertyValue("--admin-muted").trim() || "#52605d"
      });
    };

    readThemeColors();
    const observer = new MutationObserver(readThemeColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-admin-theme"] });
    return () => observer.disconnect();
  }, []);

  const openAlerts = useMemo(
    () => alerts.filter((alert) => alert.status !== "resolved"),
    [alerts]
  );
  const drillDownData = useMemo(() => getDrillDownData(movements), [movements]);

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
        data: [scanAnalytics.totalEntries, scanAnalytics.totalExits],
        backgroundColor: ["#12b76a", "#027a48"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    autoVsManual: {
      labels: ["Automatic", "Manual"],
      datasets: [{
        data: [scanAnalytics.totalAutomatic ?? 350, scanAnalytics.totalManual ?? 100],
        backgroundColor: ["#0b63e5", "#667085"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    deniedMix: {
      labels: ["Restricted", "Expired"],
      datasets: [{
        data: [scanAnalytics.totalRestricted ?? 180, scanAnalytics.totalExpired ?? 70],
        backgroundColor: ["#f04438", "#912018"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
    quality: {
      labels: ["Approved", "Denied"],
      datasets: [{
        data: [scanAnalytics.totalApproved, scanAnalytics.totalDenied],
        backgroundColor: ["#12b76a", "#f04438"],
        borderColor: themeColors.border,
        borderWidth: 4
      }]
    },
  }), [scanAnalytics, themeColors.border]);

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
      <TimeRangeSelector timeRange={timeRange} timeRanges={TIME_RANGES} onSelect={setTimeRange} />

      <KPICards alerts={alerts} scanAnalytics={scanAnalytics} />

      {/* Top Left — Scan Status */}
      <div className="analytics-donut dashboard-donut dashboard-donut-quality animate-slide-up delay-100" style={{ gridColumn: 1, gridRow: 1, alignSelf: "start", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-22px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Scan Status</div>
        <Doughnut
          data={chartData.quality}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Approved
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalApproved.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Denied
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Left — Approved Scans (Entry/Exit) */}
      <div className="analytics-donut dashboard-donut dashboard-donut-approved animate-slide-up delay-150" style={{ gridColumn: 1, gridRow: 2, alignSelf: "end", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-22px", marginBottom: "16px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Approved Scans</div>
        <Doughnut
          data={chartData.scanMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Entries
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalEntries.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#027a48", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#027a48" }} />
              Exits
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalExits.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Top Right — Scan Methods */}
      <div className="analytics-donut dashboard-donut dashboard-donut-methods animate-slide-up delay-200" style={{ gridColumn: 3, gridRow: 1, alignSelf: "start", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Scan Methods</div>
        <Doughnut
          data={chartData.autoVsManual}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#0b63e5", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0b63e5" }} />
              Automatic
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalAutomatic ?? 350).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
              Manual
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalManual ?? 100).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Right — Denied Scans */}
      <div className="analytics-donut dashboard-donut dashboard-donut-denied animate-slide-up delay-250" style={{ gridColumn: 3, gridRow: 2, alignSelf: "end", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginBottom: "16px" }}>
        <div className="dashboard-donut-title" style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Denied Scans</div>
        <Doughnut
          data={chartData.deniedMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div className="dashboard-donut-center" style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Restricted
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalRestricted ?? 180).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#912018", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#912018" }} />
              Expired
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalExpired ?? 70).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Active Alerts Widget */}
      <ActiveAlertsWidget openAlerts={openAlerts} />

      {/* Center — Drill-down Chart */}
      <div className="analytics-donut dashboard-breakdown" style={{ gridColumn: 2, gridRow: "1 / -1", alignSelf: "center", justifySelf: "center", width: "100%", height: "auto", aspectRatio: "1/1", maxWidth: "1200px", marginTop: "35px" }}>
        <DrillDownDoughnut data={drillDownData} />
        <div className="dashboard-breakdown-title" style={{ position: "absolute", top: "calc(100% + 40px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "25px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "var(--admin-text)" }}>Total Scan Breakdown</div>
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
        <style>{`
          @keyframes scrollWheel {
            0% { transform: translateY(0); opacity: 1; }
            100% { transform: translateY(10px); opacity: 0; }
          }
        `}</style>
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
          <div style={{
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
