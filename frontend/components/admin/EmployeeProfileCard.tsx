"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { AccessPermission, Alert, MovementEvent, Person } from "../../../lib/types";
import { MONTH_NAMES, type DayPattern } from "../../../lib/analyticsUtils";
import { eventTimestamp } from "../../../lib/dateRanges";
import { useDataActions } from "../../context/DataContext";
import { WorkPatternChart } from "./WorkPatternChart";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  Legend,
} from "chart.js";
import type { ChartOptions } from "chart.js";
import { useAdminTheme } from "../../hooks/useAdminTheme";

function alertTimestamp(alert: Alert) {
  const created = alert.createdAt ? new Date(alert.createdAt).getTime() : Number.NaN;
  const legacy = new Date(`${alert.date} ${alert.time}`).getTime();
  return Number.isFinite(created) ? created : Number.isFinite(legacy) ? legacy : 0;
}

function formatProfileDate(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function alertReviewLabel(alert: Alert) {
  if (alert.review?.decision === "excused" || alert.status === "resolved") return "Excused";
  if (alert.review?.decision === "confirmed" || alert.status === "warned") return "Confirmed warning";
  return alert.status === "acknowledged" ? "Acknowledged" : "Open";
}

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  Legend
);

export function EmployeeProfileCard({
  person,
  sessions,
  permissions,
  alerts,
  movements,
  onClose,
}: {
  person: Person;
  sessions: DayPattern[];
  permissions: AccessPermission[];
  alerts: Alert[];
  movements: MovementEvent[];
  onClose: () => void;
}) {
  const { queryAlerts, queryMovements } = useDataActions();
  const [timeRange, setTimeRange] = useState<"1Y" | "1M" | "1W">("1W");
  const [mounted, setMounted] = useState(false);
  const profilePermissions = useMemo(
    () => permissions.filter((permission) => permission.subjectId === person.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [permissions, person.id]
  );
  const initialAlerts = useMemo(() => alerts
    .filter((alert) => alert.subjectId === person.id || (!alert.subjectId && alert.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => alertTimestamp(right) - alertTimestamp(left)), [alerts, person.barcode, person.id]);
  const initialMovements = useMemo(() => movements
    .filter((movement) => movement.subjectId === person.id || (!movement.subjectId && movement.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => eventTimestamp(right) - eventTimestamp(left)), [movements, person.barcode, person.id]);
  const [profileAlerts, setProfileAlerts] = useState<Alert[]>(() => initialAlerts.slice(0, 8));
  const [alertTriggerCount, setAlertTriggerCount] = useState(initialAlerts.length);
  const [movementLogs, setMovementLogs] = useState<MovementEvent[]>(() => initialMovements.slice(0, 8));
  const [movementLogCount, setMovementLogCount] = useState(initialMovements.length);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const darkTheme = useAdminTheme() === "dark";

  useEffect(() => {
    let active = true;
    setHistoryLoading(true);
    setHistoryError("");
    const requests = [
      queryAlerts({ limit: 8, offset: 0, subjectId: person.id }).then((page) => {
        if (!active) return;
        setProfileAlerts(page.items);
        setAlertTriggerCount(page.total);
      }).catch(() => { if (active) setHistoryError("Some alert history could not be loaded."); }),
      queryMovements({ page: 1, pageSize: 8, subject_id: person.id, includeChart: false }).then((page) => {
        if (!active) return;
        setMovementLogs(page.items);
        setMovementLogCount(page.total);
      }).catch(() => { if (active) setHistoryError("Some movement history could not be loaded."); }),
    ];
    void Promise.all(requests).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [person.id, queryAlerts, queryMovements]);

  useEffect(() => {
    setMounted(true);
  }, []);

  let labels: string[] = [];
  let dataPoints: number[] = [];
  const now = new Date();
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const sessionsByDay = new Map(sessions.map((session) => [dayKey(session.dateObj), session.workedHours]));
  
  if (timeRange === "1W") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      labels.push(`${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`);
      dataPoints.push(sessionsByDay.get(dayKey(d)) ?? 0);
    }
  } else if (timeRange === "1M") {
    for (let i = 29; i >= 0; i -= 3) {
      const start = new Date(now);
      start.setDate(now.getDate() - i);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 2);
      end.setHours(23, 59, 59, 999);
      labels.push(`${start.getDate()} ${MONTH_NAMES[start.getMonth()]}`);

      let threeDayTotal = 0;
      for (const session of sessions) {
        if (session.dateObj >= start && session.dateObj <= end) {
          threeDayTotal += session.workedHours;
        }
      }
      dataPoints.push(Number(threeDayTotal.toFixed(1)));
    }
  } else if (timeRange === "1Y") {
    const monthlyData = new Map<string, number>();
    for (const session of sessions) {
      const key = `${session.dateObj.getFullYear()}-${session.dateObj.getMonth()}`;
      monthlyData.set(key, (monthlyData.get(key) ?? 0) + session.workedHours);
    }
    const today = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      labels.push(MONTH_NAMES[d.getMonth()]);
      dataPoints.push(monthlyData.get(`${d.getFullYear()}-${d.getMonth()}`) ?? 0);
    }
  }

  const totalHours = dataPoints.reduce((sum, val) => sum + val, 0);
  const displayedHours = Number.isInteger(totalHours) ? String(totalHours) : totalHours.toFixed(1);
  const trendUnit = timeRange === "1Y" ? "YOY" : timeRange === "1M" ? "MOM" : "WOW";
  const panelBackground = darkTheme ? "#0f1413" : "rgb(237, 242, 240)";
  const textColor = darkTheme ? "#eef7f2" : "#18201f";
  const mutedColor = darkTheme ? "#aab8b3" : "#667085";
  const borderColor = darkTheme ? "#2e2e2e" : "rgba(24, 32, 31, 0.18)";
  const panelLine = darkTheme ? "rgba(196, 211, 204, 0.24)" : "rgba(176, 190, 186, 0.5)";
  const tooltipBackground = darkTheme ? "#151515" : "#ffffff";
  const tooltipBody = darkTheme ? "#aab8b3" : "#4b5563";

  const chartData = {
    labels,
    datasets: [
      {
        label: "Hours Worked",
        data: dataPoints,
        borderColor: "#ea580c",
        backgroundColor: "rgba(234, 88, 12, 0.15)",
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 3,
      },
    ],
  };

  const chartFont = {
    family: "var(--admin-font, 'Urbanist', sans-serif)",
    size: 14,
  };

  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 74, // Give space for the absolute header so the line doesn't hit the text
        left: 0,
        right: 0,
        bottom: 8,
      }
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        displayColors: false,
        backgroundColor: tooltipBackground,
        titleColor: textColor,
        bodyColor: tooltipBody,
        borderColor,
        borderWidth: 1,
        titleFont: { ...chartFont, weight: 700 as const },
        bodyFont: { ...chartFont },
      },
    },
    scales: {
      y: {
        display: true,
        beginAtZero: true,
        border: { display: false },
        grid: { display: false },
        ticks: {
          font: chartFont,
          color: mutedColor,
        }
      },
      x: {
        grid: {
          display: false,
        },
        border: {
          display: false,
        },
        ticks: {
          font: chartFont,
          color: mutedColor,
        }
      },
    },
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className="employee-profile-overlay"
      style={{
        background: "rgba(0, 0, 0, 0.4)",
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        className="employee-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-profile-title"
        style={{
          "--admin-bg": panelBackground,
          "--admin-text": textColor,
          "--admin-muted": mutedColor,
          "--admin-line": panelLine,
          "--profile-border": borderColor,
          "--profile-shadow": darkTheme ? "0 24px 80px rgba(0, 0, 0, 0.48)" : "0 24px 60px rgba(45, 56, 54, 0.2)",
        } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="employee-profile-header">
          <h2 id="employee-profile-title">Employee Profile</h2>
          <div className="employee-profile-header-actions">
            <div className="employee-profile-range-controls">
              {(["1Y", "1M", "1W"] as const).map((range) => {
                const isSelected = range === timeRange;
                return (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    className="employee-profile-range-button"
                    aria-pressed={isSelected}
                  >
                    {range}
                  </button>
                );
              })}
            </div>
            <button
              className="admin-button admin-button--icon icon-button employee-profile-close"
              type="button"
              onClick={onClose}
              aria-label="Close employee profile"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="employee-profile-content">
          <div className="employee-profile-details">
            <div className="employee-profile-detail">
              <div className="employee-profile-detail-label">Name</div>
              <div className="employee-profile-detail-value" style={{ color: textColor }}>{person.name}</div>
            </div>
            <div className="employee-profile-detail">
              <div className="employee-profile-detail-label">Barcode</div>
              <div className="employee-profile-detail-value" style={{ color: textColor }}>{person.barcode}</div>
            </div>
            <div className="employee-profile-detail">
              <div className="employee-profile-detail-label">Assigned zones</div>
              <div className="employee-profile-detail-value">{person.allowedZones.length ? person.allowedZones.join(" · ") : "No zones assigned"}</div>
            </div>
          </div>

          <div className="employee-profile-summary-grid" aria-label="Employee activity totals">
            <article className="employee-profile-summary-card"><span>Permissions</span><strong>{profilePermissions.length}</strong></article>
            <article className="employee-profile-summary-card"><span>Alert triggers</span><strong>{alertTriggerCount}</strong></article>
            <article className="employee-profile-summary-card"><span>Movement logs</span><strong>{movementLogCount}</strong></article>
          </div>

          <div className="employee-profile-hours-chart">
            <div className="employee-profile-chart-summary">
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div className="employee-profile-summary-number" style={{ color: textColor }}>
                    {displayedHours}
                  </div>
                  <div className="employee-profile-summary-trend">
                    ↑ 12% {trendUnit}
                  </div>
                </div>
                <div className="employee-profile-summary-label" style={{ color: mutedColor }}>
                  TOTAL HOURS
                </div>
              </div>
            </div>
            
            <div className="employee-profile-hours-chart-canvas">
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>

          <div className="employee-profile-work-pattern">
            <WorkPatternChart timeRange={timeRange} sessions={sessions} />
          </div>

          <div className="employee-profile-record-grid">
            <section className="employee-profile-record-section" aria-labelledby="employee-profile-permissions-title">
              <h3 id="employee-profile-permissions-title">Employee permissions</h3>
              {profilePermissions.length ? <ul className="employee-profile-record-list">
                {profilePermissions.slice(0, 6).map((permission) => <li key={permission.id}>
                  <div className="employee-profile-record-heading"><strong>{permission.zones.length ? permission.zones.join(" · ") : permission.assignment}</strong><span data-state={permission.state}>{permission.state.replaceAll("_", " ")}</span></div>
                  <small>{formatProfileDate(permission.validFrom)} – {permission.validTo ? formatProfileDate(permission.validTo) : "No expiry"}</small>
                  {permission.reason ? <p>{permission.reason}</p> : null}
                </li>)}
              </ul> : <p className="employee-profile-empty">No individual permission records.</p>}
            </section>

            <section className="employee-profile-record-section" aria-labelledby="employee-profile-alert-triggers-title">
              <h3 id="employee-profile-alert-triggers-title">Alert triggers</h3>
              {profileAlerts.length ? <ul className="employee-profile-record-list">
                {profileAlerts.slice(0, 8).map((alert) => <li key={alert.id}>
                  <div className="employee-profile-record-heading"><strong>{alert.title}</strong><span data-state={alert.review?.decision ?? alert.status}>{alertReviewLabel(alert)}</span></div>
                  <small>{formatProfileDate(alert.createdAt || `${alert.date} ${alert.time}`)} · {alert.severity}</small>
                </li>)}
              </ul> : <p className="employee-profile-empty">{historyLoading ? "Loading alert history…" : "No alert triggers recorded."}</p>}
            </section>

            <section className="employee-profile-record-section employee-profile-movement-section" aria-labelledby="employee-profile-movements-title">
              <h3 id="employee-profile-movements-title">Movement logs</h3>
              {movementLogs.length ? <div className="employee-profile-movement-table-wrap">
                <table className="employee-profile-movement-table">
                  <caption className="sr-only">Movement history for {person.name}</caption>
                  <thead><tr><th scope="col">Date &amp; time</th><th scope="col">Direction</th><th scope="col">Checkpoint</th><th scope="col">Result</th><th scope="col">Scan</th><th scope="col">Details</th></tr></thead>
                  <tbody>{movementLogs.slice(0, 8).map((movement) => {
                    const timestamp = movement.createdAt || `${movement.date} ${movement.time}`;
                    const details = movement.reason?.trim() || movement.denialCode?.replaceAll("_", " ") || (movement.result === "approved" ? "Access permitted" : "Access denied");
                    const scanType = movement.manualReviewedAt ? "Manual review" : movement.scanType === "manual" ? "Manual scan" : movement.scanType === "auto" ? "Automatic" : "Not recorded";
                    return <tr key={movement.id}>
                      <td><time dateTime={movement.createdAt || undefined}>{formatProfileDate(timestamp)}</time></td>
                      <td>{movement.direction === "entry" ? "Entry" : "Exit"}</td>
                      <td>{movement.checkpoint || "Not recorded"}</td>
                      <td><span className="employee-profile-movement-result" data-result={movement.result}>{movement.result === "approved" ? "Allowed" : "Denied"}</span></td>
                      <td>{scanType}</td>
                      <td>{details}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div> : <p className="employee-profile-empty">{historyLoading ? "Loading movement logs…" : "No movement logs recorded."}</p>}
            </section>
          </div>
          {historyError ? <p className="employee-profile-history-error" role="status">{historyError}</p> : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
