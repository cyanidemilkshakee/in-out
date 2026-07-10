"use client";

import { useMemo } from "react";
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
    <section className="dashboard-analytics" aria-label="Dashboard analytics">
      <article className="analytics-card">
        <div className="analytics-card-header">
          <div>
            <h2>Scan Results</h2>
          </div>
          <strong>{scanAnalytics.totalScans.toLocaleString()}</strong>
        </div>
        <div className="analytics-donut">
          <Doughnut
            data={qualityData}
            options={{
              cutout: "75%",
              maintainAspectRatio: false,
              plugins: { ...sharedPlugins, legend: { display: false } }
            }}
          />
          <div style={{
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: "12px",
            pointerEvents: "none"
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
                Approved
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{scanAnalytics.totalApproved.toLocaleString()}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
                Denied
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{scanAnalytics.totalDenied.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </article>

      <article className="analytics-card">
        <div className="analytics-card-header">
          <div>
            <h2>Approved Scan Composition</h2>
          </div>
          <strong>{scanAnalytics.totalApproved.toLocaleString()}</strong>
        </div>
        <div className="analytics-donut">
          <Doughnut
            data={scanMixData}
            options={{
              cutout: "75%",
              maintainAspectRatio: false,
              plugins: { ...sharedPlugins, legend: { display: false } }
            }}
          />
          <div style={{
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: "12px",
            pointerEvents: "none"
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
                Entries
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{scanAnalytics.totalEntries.toLocaleString()}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#027a48", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#027a48" }} />
                Exits
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{scanAnalytics.totalExits.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </article>

      <article className="analytics-card">
        <div className="analytics-card-header">
          <div>
            <h2>Automatic vs Manual</h2>
          </div>
          <strong>{scanAnalytics.totalScans.toLocaleString()}</strong>
        </div>
        <div className="analytics-donut">
          <Doughnut
            data={autoVsManualData}
            options={{
              cutout: "75%",
              maintainAspectRatio: false,
              plugins: { ...sharedPlugins, legend: { display: false } }
            }}
          />
          <div style={{
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: "12px",
            pointerEvents: "none"
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#0b63e5", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0b63e5" }} />
                Automatic
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{(scanAnalytics.totalAutomatic ?? 350).toLocaleString()}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
                Manual
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{(scanAnalytics.totalManual ?? 100).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </article>

      <article className="analytics-card">
        <div className="analytics-card-header">
          <div>
            <h2>Denied Scan Composition</h2>
          </div>
          <strong>{scanAnalytics.totalDenied.toLocaleString()}</strong>
        </div>
        <div className="analytics-donut">
          <Doughnut
            data={deniedMixData}
            options={{
              cutout: "75%",
              maintainAspectRatio: false,
              plugins: { ...sharedPlugins, legend: { display: false } }
            }}
          />
          <div style={{
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: "12px",
            pointerEvents: "none"
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
                Restricted
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{(scanAnalytics.totalRestricted ?? 180).toLocaleString()}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#912018", fontSize: "12px", fontWeight: 750, textTransform: "uppercase" }}>
                <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#912018" }} />
                Expired
              </div>
              <div style={{ fontSize: "20px", fontWeight: 800, marginTop: "0px", lineHeight: 1.1 }}>{(scanAnalytics.totalExpired ?? 70).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </article>

      <article className="analytics-card analytics-alert-card">
        <div className="analytics-card-header compact">
          <div>
            <h2>Open Alerts</h2>
          </div>
          <strong>{chartModel.openAlerts.length}</strong>
        </div>
        <ul className="analytics-alert-list">
          {chartModel.openAlerts.map((alert) => (
            <li key={alert.id}>
              <span className={`analytics-severity analytics-severity-${alert.severity}`}>
                {alert.severity}
              </span>
              <div>
                <strong>{alert.title}</strong>
                <small>{alert.checkpoint} / {alert.time}</small>
              </div>
            </li>
          ))}
        </ul>
      </article>



      <article className="analytics-card analytics-card-full" style={{ minHeight: "520px", display: "flex", flexDirection: "column" }}>
        <div className="analytics-card-header compact" style={{ justifyContent: "center", marginBottom: "20px" }}>
          <div style={{ textAlign: "center" }}>
            <h2>Scan Drill-down</h2>
          </div>
        </div>
        <div className="analytics-donut" style={{ height: "450px", width: "450px", margin: "0 auto" }}>
          <DrillDownDoughnut data={mockData} />
        </div>
      </article>
    </section>
  );
}
