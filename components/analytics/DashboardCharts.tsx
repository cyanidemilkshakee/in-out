"use client";

import { useMemo, useState } from "react";
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { Bell } from "lucide-react";
import { DrillDownDoughnut, mockData } from "./DrillDownDoughnut";
import type { Alert, MovementEvent, ScanAnalytics, Scanner } from "../../lib/types";

ChartJS.register(
  ArcElement,
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
);

type DashboardChartsProps = {
  alerts: Alert[];
  events: MovementEvent[];
  scanAnalytics: ScanAnalytics;
  scanners: Scanner[];
};

const chartFont = {
  family: "var(--admin-font)"
};

const quietGrid = "rgba(24, 32, 31, 0.08)";
const mutedText = "#52605d";

function countBy<T extends string>(items: T[]) {
  return items.reduce<Record<T, number>>((totals, item) => {
    totals[item] = (totals[item] ?? 0) + 1;
    return totals;
  }, {} as Record<T, number>);
}

function timeToMinutes(time: string) {
  const match = time.match(/^(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)$/);
  if (!match) {
    return 0;
  }

  const [, rawHour, rawMinute, , period] = match;
  const hour = (Number(rawHour) % 12) + (period === "PM" ? 12 : 0);
  return hour * 60 + Number(rawMinute);
}

function formatWindowLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

export function DashboardCharts({
  alerts,
  events,
  scanAnalytics,
  scanners
}: DashboardChartsProps) {
  const [timeRange, setTimeRange] = useState("Today");
  const timeRanges = ["Today", "This Week", "This Month", "This Year", "All Time"];
  const chartModel = useMemo(() => {
    const checkpointNames = Array.from(new Set(events.map((event) => event.checkpoint)));
    const checkpointEntries = checkpointNames.map(
      (checkpoint) =>
        events.filter((event) => event.checkpoint === checkpoint && event.direction === "entry")
          .length
    );
    const checkpointExits = checkpointNames.map(
      (checkpoint) =>
        events.filter((event) => event.checkpoint === checkpoint && event.direction === "exit")
          .length
    );

    const resultCounts = countBy(events.map((event) => event.result));
    const scannerCounts = countBy(scanners.map((scanner) => scanner.status));
    const exceptionTotal = events.filter((event) => event.result !== "success").length;
    const successTotal = events.length - exceptionTotal;

    const sortedEvents = [...events].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    const firstMinute = sortedEvents[0] ? Math.floor(timeToMinutes(sortedEvents[0].time) / 2) * 2 : 0;
    const windows = Array.from({ length: 5 }, (_, index) => firstMinute + index * 2);
    const activityEntries = windows.map(
      (windowStart) =>
        sortedEvents.filter((event) => {
          const minutes = timeToMinutes(event.time);
          return event.direction === "entry" && minutes >= windowStart && minutes < windowStart + 2;
        }).length
    );
    const activityExits = windows.map(
      (windowStart) =>
        sortedEvents.filter((event) => {
          const minutes = timeToMinutes(event.time);
          return event.direction === "exit" && minutes >= windowStart && minutes < windowStart + 2;
        }).length
    );

    const openAlerts = alerts.filter((alert) => alert.status !== "resolved");

    return {
      activityEntries,
      activityExits,
      checkpointEntries,
      checkpointExits,
      checkpointNames,
      exceptionTotal,
      openAlerts,
      resultCounts,
      scannerCounts,
      successTotal,
      windows: windows.map(formatWindowLabel)
    };
  }, [alerts, events, scanners]);

  const sharedPlugins = {
    legend: {
      labels: {
        boxHeight: 9,
        boxWidth: 9,
        color: mutedText,
        font: { ...chartFont, size: 12, weight: 700 }
      }
    },
    tooltip: {
      backgroundColor: "#18201f",
      bodyFont: { ...chartFont, size: 12 },
      cornerRadius: 8,
      displayColors: false,
      titleFont: { ...chartFont, size: 12, weight: 800 }
    }
  } as const;

  const scanMixData = {
    labels: ["Entries", "Exits"],
    datasets: [
      {
        data: [
          scanAnalytics.totalEntries,
          scanAnalytics.totalExits
        ],
        backgroundColor: ["#12b76a", "#027a48"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }
    ]
  };

  const autoVsManualData = {
    labels: ["Automatic", "Manual"],
    datasets: [
      {
        data: [
          scanAnalytics.totalAutomatic ?? 350,
          scanAnalytics.totalManual ?? 100
        ],
        backgroundColor: ["#0b63e5", "#667085"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }
    ]
  };

  const deniedMixData = {
    labels: ["Restricted", "Expired"],
    datasets: [
      {
        data: [
          scanAnalytics.totalRestricted ?? 180,
          scanAnalytics.totalExpired ?? 70
        ],
        backgroundColor: ["#f04438", "#912018"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }
    ]
  };

  const checkpointData = {
    labels: chartModel.checkpointNames,
    datasets: [
      {
        label: "Entries",
        data: chartModel.checkpointEntries,
        backgroundColor: "#12b76a",
        borderRadius: 6
      },
      {
        label: "Exits",
        data: chartModel.checkpointExits,
        backgroundColor: "#0b63e5",
        borderRadius: 6
      }
    ]
  };

  const activityData = {
    labels: chartModel.windows,
    datasets: [
      {
        label: "Entries",
        data: chartModel.activityEntries,
        borderColor: "#12b76a",
        backgroundColor: "rgba(18, 183, 106, 0.14)",
        fill: true,
        pointBackgroundColor: "#12b76a",
        pointBorderWidth: 0,
        tension: 0.36
      },
      {
        label: "Exits",
        data: chartModel.activityExits,
        borderColor: "#f04438",
        backgroundColor: "rgba(240, 68, 56, 0.14)",
        fill: true,
        pointBackgroundColor: "#f04438",
        pointBorderWidth: 0,
        tension: 0.36
      }
    ]
  };

  const qualityData = {
    labels: ["Approved", "Denied"],
    datasets: [
      {
        data: [scanAnalytics.totalApproved, scanAnalytics.totalDenied],
        backgroundColor: ["#12b76a", "#f04438"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }
    ]
  };

  const scannerData = {
    labels: ["Online", "Warning", "Offline"],
    datasets: [
      {
        data: [
          chartModel.scannerCounts.online ?? 0,
          chartModel.scannerCounts.warning ?? 0,
          chartModel.scannerCounts.offline ?? 0
        ],
        backgroundColor: ["#12b76a", "#f79009", "#f04438"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }
    ]
  };

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
      padding: "50px 24px 24px 24px",
      boxSizing: "border-box",
      zIndex: 0
    }}>
      {/* Time Range Selector */}
      <div style={{
        position: "absolute",
        top: "40px",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        background: "rgba(24, 32, 31, 0.04)",
        padding: "6px",
        borderRadius: "20px",
        gap: "6px",
        zIndex: 10
      }}>
        {timeRanges.map(range => (
          <button
            key={range}
            onClick={() => setTimeRange(range)}
            style={{
              background: timeRange === range ? "#fff" : "transparent",
              color: timeRange === range ? "#000" : "#52605d",
              border: "none",
              padding: "8px 18px",
              borderRadius: "16px",
              fontSize: "16px",
              fontWeight: timeRange === range ? 700 : 600,
              cursor: "pointer",
              boxShadow: timeRange === range ? "0 2px 6px rgba(0,0,0,0.1)" : "none",
              transition: "all 0.2s ease"
            }}
          >
            {range}
          </button>
        ))}
      </div>

      {/* Top Left */}
      <div className="analytics-donut" style={{ gridColumn: 1, gridRow: 1, alignSelf: "start", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", transform: "translateX(-24px)" }}>
        <Doughnut
          data={qualityData}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center", marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Approved
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalApproved.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Denied
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Top Right */}
      <div className="analytics-donut" style={{ gridColumn: 3, gridRow: 1, alignSelf: "start", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1" }}>
        <Doughnut
          data={scanMixData}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center", marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Entries
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalEntries.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#027a48", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#027a48" }} />
              Exits
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalExits.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Left */}
      <div className="analytics-donut" style={{ gridColumn: 1, gridRow: 2, alignSelf: "end", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", transform: "translateX(-24px)", marginBottom: "16px" }}>
        <Doughnut
          data={autoVsManualData}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center", marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#0b63e5", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0b63e5" }} />
              Automatic
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalAutomatic ?? 350).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
              Manual
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalManual ?? 100).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Right */}
      <div className="analytics-donut" style={{ gridColumn: 3, gridRow: 2, alignSelf: "end", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginBottom: "16px" }}>
        <Doughnut
          data={deniedMixData}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center", marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Restricted
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalRestricted ?? 180).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#912018", fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#912018" }} />
              Expired
            </div>
            <div style={{ fontSize: "18px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalExpired ?? 70).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Center Right - Active Alerts Box */}
      <div style={{
        gridColumn: 3,
        gridRow: "1 / -1",
        alignSelf: "center",
        justifySelf: "end",
        background: "#fff",
        padding: "16px",
        borderRadius: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        width: "100%",
        maxWidth: "360px",
        height: "220px",
        border: "1px solid rgba(0,0,0,0.06)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.04)",
        overflow: "hidden"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: "12px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Bell size={16} strokeWidth={2.5} color="#f04438" />
            <span style={{ fontSize: "12px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.5px", color: "#18201f" }}>Active Alerts</span>
          </div>
          <div style={{ background: "#f04438", color: "#fff", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: 800 }}>
            {chartModel.openAlerts.length}
          </div>
        </div>
        
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto", paddingRight: "4px" }}>
          {chartModel.openAlerts.map(alert => (
            <div key={alert.id} style={{
              padding: "12px",
              borderRadius: "12px",
              background: alert.severity === "critical" ? "rgba(240, 68, 56, 0.08)" : alert.severity === "high" ? "rgba(247, 144, 9, 0.08)" : "rgba(24, 32, 31, 0.04)",
              border: `1px solid ${alert.severity === "critical" ? "rgba(240, 68, 56, 0.15)" : alert.severity === "high" ? "rgba(247, 144, 9, 0.15)" : "rgba(0,0,0,0.05)"}`,
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              flexShrink: 0
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#18201f", lineHeight: 1.2 }}>{alert.title}</div>
                <div style={{ fontSize: "10px", fontWeight: 600, color: "#52605d", flexShrink: 0 }}>
                  {new Date(alert.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div style={{ fontSize: "11px", color: "#52605d", lineHeight: 1.4 }}>
                {alert.subjectName} ({alert.barcode})
              </div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: alert.severity === "critical" ? "#d92d20" : alert.severity === "high" ? "#b54708" : "#52605d", textTransform: "uppercase" }}>
                📍 {alert.checkpoint}
              </div>
            </div>
          ))}
          {chartModel.openAlerts.length === 0 && (
            <div style={{ textAlign: "center", color: "#52605d", fontSize: "12px", fontWeight: 500, padding: "24px 0" }}>
              No active alerts
            </div>
          )}
        </div>
      </div>

      {/* Center - Drill-down Chart */}
      <div className="analytics-donut" style={{ gridColumn: 2, gridRow: "1 / -1", alignSelf: "center", justifySelf: "center", width: "100%", height: "auto", aspectRatio: "1/1", maxWidth: "1200px" }}>
        <DrillDownDoughnut data={mockData} />
      </div>

      <div 
        style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "14px",
          cursor: "pointer",
          zIndex: 10,
        }}
        onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}
      >
        <style>{`
          @keyframes scrollWheel {
            0% { transform: translateY(0); opacity: 1; }
            100% { transform: translateY(10px); opacity: 0; }
          }
        `}</style>
        <span style={{
          fontSize: "12px",
          fontWeight: 800,
          letterSpacing: "3px",
          color: "#475467",
          textTransform: "uppercase",
          marginRight: "-3px", /* Compensate for letter spacing to perfectly center */
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
            backgroundColor: "#fdb022",
            borderRadius: "1.5px",
            boxShadow: "0 0 4px 1px rgba(253, 176, 34, 0.8)",
            animation: "scrollWheel 1.5s cubic-bezier(0.15, 0.41, 0.69, 0.94) infinite"
          }} />
        </div>
      </div>
    </section>
  );
}
