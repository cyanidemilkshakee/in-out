"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Bell, Download, History, ScanLine, ShieldCheck, X } from "lucide-react";
import type { Alert, EmployeeActivity, MovementEvent, Person } from "../../../lib/types";
import { assertCsvBound, readExport } from "../../../lib/exportRead";
import type { DayPattern } from "../../../lib/analyticsUtils";
import { facilityZoneLabel, normalizeFacilityZones } from "../../../lib/facilityZones";
import { normalizeCheckpointLabel } from "../../../lib/normalizeDashboard";
import { averageWorkedHoursPerDay, employeeActivityPatterns, employeeActivityRangeDays, employeeHoursSeries } from "../../../lib/analyticsQueries";
import { eventTimestamp } from "../../../lib/dateRanges";
import { createRefreshScheduler } from "../../../lib/refreshScheduler";
import { useDataActions } from "../../context/DataContext";
import { WorkPatternChart } from "./WorkPatternChart";
import { EmployeeProfileAlerts } from "./EmployeeProfileAlerts";
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
import "./EmployeeProfileCard.css";

function alertTimestamp(alert: Alert) {
  const created = alert.createdAt ? new Date(alert.createdAt).getTime() : Number.NaN;
  const legacy = new Date(`${alert.date} ${alert.time}`).getTime();
  return Number.isFinite(created) ? created : Number.isFinite(legacy) ? legacy : 0;
}

function formatProfileTime(value?: string, fallbackTime?: string) {
  if (!value) return fallbackTime || "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallbackTime || "Not recorded"
    : date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

const PROFILE_MOVEMENT_PAGE_SIZE = 100;

function exportMovementCsv(person: Person, movements: MovementEvent[]) {
  if (!movements.length) return;
  const columns: Array<[string, (movement: MovementEvent) => unknown]> = [
    ["eventId", (movement) => movement.id],
    ["occurredAt", (movement) => movement.createdAt || `${movement.date} ${movement.time}`],
    ["subject", (movement) => movement.subjectName],
    ["subjectType", (movement) => movement.subjectType],
    ["barcode", (movement) => movement.barcode],
    ["direction", (movement) => movement.direction],
    ["checkpoint", (movement) => movement.checkpoint],
    ["result", (movement) => movement.result],
    ["reason", (movement) => movement.reason || movement.denialCode || ""],
    ["scanType", (movement) => movement.scanType],
    ["captureMethod", (movement) => movement.captureMethod],
    ["manualReviewedAt", (movement) => movement.manualReviewedAt],
    ["syncState", (movement) => movement.syncState],
    ["source", (movement) => movement.source],
    ["paperReference", (movement) => movement.paperReference],
  ];
  const csv = [
    columns.map(([name]) => csvCell(name)).join(","),
    ...movements.map((movement) => columns.map(([, value]) => csvCell(value(movement))).join(",")),
  ].join("\r\n");
  assertCsvBound(csv);
  const slug = person.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employee";
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `movement-logs-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
  alerts,
  movements,
  onClose,
}: {
  person: Person;
  sessions: DayPattern[];
  alerts: Alert[];
  movements: MovementEvent[];
  onClose: () => void;
}) {
  const { queryMovements, queryEmployeeActivity, updatePerson } = useDataActions();
  const [timeRange, setTimeRange] = useState<"1W" | "1M" | "1Y">("1W");
  const [mounted, setMounted] = useState(false);
  const initialAlerts = useMemo(() => alerts
    .filter((alert) => alert.subjectId === person.id || (!alert.subjectId && alert.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => alertTimestamp(right) - alertTimestamp(left)), [alerts, person.barcode, person.id]);
  const initialMovements = useMemo(() => movements
    .filter((movement) => movement.subjectId === person.id || (!movement.subjectId && movement.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => eventTimestamp(right) - eventTimestamp(left)), [movements, person.barcode, person.id]);
  const [movementLogs, setMovementLogs] = useState<MovementEvent[]>(() => initialMovements);
  const [movementLogCount, setMovementLogCount] = useState(initialMovements.length);
  const [movementNextPage, setMovementNextPage] = useState(2);
  const [movementLoadingMore, setMovementLoadingMore] = useState(false);
  const movementMorePending = useRef(false);
  const movementMoreController = useRef<AbortController | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [profileRevision, setProfileRevision] = useState(0);
  const [exportingHistory, setExportingHistory] = useState(false);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  function toggleAlertHistory() {
    setShowAlertHistory((visible) => !visible);
    requestAnimationFrame(() => {
      document.getElementById("employee-profile-alert-history")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
  }
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => {
    exportController.current?.abort();
    movementMoreController.current?.abort();
  }, []);
  const historyPerson = useRef(person.id);
  const [activity, setActivity] = useState<EmployeeActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState("");
  const [employeeEnabled, setEmployeeEnabled] = useState(person.type === "employee" && person.status === "active");
  const [employeeStatusBusy, setEmployeeStatusBusy] = useState(false);
  const [employeeStatusError, setEmployeeStatusError] = useState("");
  const darkTheme = useAdminTheme() === "dark";
  const assignedZones = normalizeFacilityZones(person.allowedZones);
  const subjectMovementRevision = useMemo(() => initialMovements.map(movement =>
    [movement.id, movement.result, movement.direction, movement.scanType, movement.createdAt, movement.manualReviewedAt].join(":"))
    .join("|"), [initialMovements]);

  useEffect(() => {
    const scheduler = createRefreshScheduler(() => setProfileRevision(value => value + 1));
    const refresh = () => scheduler.request();
    const receive = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        if (update.type === "data_changed" || update.subject_id === person.id || update.movement?.subjectId === person.id ||
          update.permission?.subjectId === person.id || update.request?.subjectId === person.id) refresh();
      } catch { /* A reconnect reconciles malformed events. */ }
    };
    window.addEventListener("inout:presence-message", receive);
    window.addEventListener("inout:presence-sync", refresh);
    return () => { scheduler.cancel(); window.removeEventListener("inout:presence-message", receive); window.removeEventListener("inout:presence-sync", refresh); };
  }, [person.id]);

  async function downloadMovementHistory() {
    if (exportingHistory) return;
    setExportingHistory(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    exportController.current = controller;
    try {
      const result = await readExport<{ items: MovementEvent[] }>("movements", { subject_id: person.id }, controller.signal);
      exportMovementCsv(person, result.items);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "Unable to export movement history."); }
    finally { clearTimeout(timer); setExportingHistory(false); }
  }

  useEffect(() => {
    setEmployeeEnabled(person.type === "employee" && person.status === "active");
  }, [person.id, person.status, person.type]);

  async function setEmployeeStatus(enabled: boolean) {
    if (person.type !== "employee" || employeeStatusBusy) return;
    const previous = employeeEnabled;
    setEmployeeEnabled(enabled);
    setEmployeeStatusBusy(true);
    setEmployeeStatusError("");
    try {
      await updatePerson(person.id, { status: enabled ? "active" : "inactive" });
    } catch (error) {
      setEmployeeEnabled(previous);
      setEmployeeStatusError(error instanceof Error ? error.message : "Unable to update employee status.");
    } finally {
      setEmployeeStatusBusy(false);
    }
  }

  useEffect(() => {
    const movementLoadController = new AbortController();
    setHistoryLoading(true);
    setHistoryError("");
    movementMoreController.current?.abort();
    movementMorePending.current = false;
    setMovementLoadingMore(false);
    setMovementNextPage(2);
    if (historyPerson.current !== person.id) {
      historyPerson.current = person.id;
      setMovementLogs([]);
      setMovementLogCount(0);
    }
    void queryMovements({ page: 1, pageSize: PROFILE_MOVEMENT_PAGE_SIZE, subject_id: person.id, includeChart: false }, movementLoadController.signal)
      .then(page => {
        if (movementLoadController.signal.aborted) return;
        setMovementLogs(page.items);
        setMovementLogCount(page.total);
        setMovementNextPage(2);
      }).catch(() => { if (!movementLoadController.signal.aborted) setHistoryError("Some movement history could not be loaded."); })
      .finally(() => { if (!movementLoadController.signal.aborted) setHistoryLoading(false); });
    return () => movementLoadController.abort();
  }, [person.id, queryMovements, subjectMovementRevision, profileRevision]);

  const loadMoreMovementLogs = useCallback(async () => {
    if (historyLoading || movementMorePending.current || movementLogs.length >= movementLogCount) return;
    const controller = new AbortController();
    movementMoreController.current?.abort();
    movementMoreController.current = controller;
    movementMorePending.current = true;
    setMovementLoadingMore(true);
    try {
      const page = await queryMovements({
        page: movementNextPage, pageSize: PROFILE_MOVEMENT_PAGE_SIZE,
        subject_id: person.id, includeChart: false,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setMovementLogs((current) => {
        const merged = new Map<string, MovementEvent>(current.map((movement) => [movement.id, movement] as const));
        page.items.forEach((movement) => merged.set(movement.id, movement));
        return [...merged.values()].sort((left, right) => eventTimestamp(right) - eventTimestamp(left));
      });
      setMovementLogCount(page.total);
      setMovementNextPage((current) => current + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "Some movement history could not be loaded.");
    } finally {
      if (movementMoreController.current === controller) {
        movementMorePending.current = false;
        setMovementLoadingMore(false);
      }
    }
  }, [historyLoading, movementLogCount, movementLogs.length, movementNextPage, person.id, queryMovements]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setActivity(null);
    setActivityLoading(true);
    setActivityError("");
    void queryEmployeeActivity({ subjectId: person.id, days: timeRange === "1Y" ? 365 : timeRange === "1M" ? 30 : 7 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setActivity(result); })
      .catch(() => { if (!controller.signal.aborted) setActivityError("Worked hours could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setActivityLoading(false); });
    return () => controller.abort();
  }, [person.id, timeRange, queryEmployeeActivity, subjectMovementRevision, profileRevision]);

  const { labels, dataPoints } = useMemo(() => activity
    ? employeeHoursSeries(activity, timeRange) : { labels: [], dataPoints: [] }, [activity, timeRange]);
  const completeSessions = useMemo(() => activity ? employeeActivityPatterns(activity) : [], [activity]);
  const periodDays = employeeActivityRangeDays(timeRange);
  const averageHoursPerDay = activity ? averageWorkedHoursPerDay(activity.days, periodDays) : null;
  const displayedAverageHours = averageHoursPerDay === null ? "—" : averageHoursPerDay.toFixed(1);
  const panelBackground = darkTheme ? "#0f1413" : "#f4f7f5";
  const textColor = darkTheme ? "#eef7f2" : "#18201f";
  const mutedColor = darkTheme ? "#aab8b3" : "#667085";
  const borderColor = darkTheme ? "#2f3d39" : "#dce5e0";
  const panelLine = darkTheme ? "rgba(196, 211, 204, 0.24)" : "rgba(176, 190, 186, 0.5)";
  const tooltipBackground = darkTheme ? "#151515" : "#ffffff";
  const tooltipBody = darkTheme ? "#aab8b3" : "#4b5563";

  const chartData = {
    labels,
    datasets: [
      {
        label: "Average hours per day",
        data: dataPoints,
        borderColor: "#ea580c",
        backgroundColor: "rgba(234, 88, 12, 0.09)",
        fill: true,
        tension: 0.4,
        pointRadius: dataPoints.length === 1 ? 4 : 0,
        pointHoverRadius: 5,
        borderWidth: 2,
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
        top: 8,
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

  const movementHistory = (
    <section className="employee-profile-record-section employee-profile-movement-section scrollable-content" aria-label="Movement logs">
      <div className="employee-profile-movement-header">
        <h3>Movement logs</h3>
        <span className="employee-profile-record-count">{movementLogCount} records</span>
      </div>
      {historyError ? <p className="employee-profile-history-error" role="status">{historyError}</p> : null}
      {movementLogs.length ? <div className="employee-profile-movement-table-wrap" onScroll={(event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadMoreMovementLogs();
      }}>
        <table className="employee-profile-movement-table">
          <caption className="sr-only">Movement history for {person.name}</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Movement</th><th scope="col">Checkpoint</th><th scope="col">Scan type</th><th scope="col">Result</th></tr></thead>
          <tbody>{movementLogs.map((movement) => {
            const timestamp = movement.createdAt || `${movement.date} ${movement.time}`;
            const scanType = movement.manualReviewedAt ? "Manual review" : movement.scanType === "manual" ? "Manual scan" : movement.scanType === "auto" ? "Automatic" : "Not recorded";
            return <tr key={movement.id}>
              <td><time dateTime={movement.createdAt || undefined}>{formatProfileTime(timestamp, movement.time)}</time></td>
              <td><span className="employee-profile-movement-direction">{movement.direction === "entry" ? "Entry" : "Exit"}</span></td>
              <td>{normalizeCheckpointLabel(movement.checkpoint) || "Not recorded"}</td>
              <td>{scanType}</td>
              <td><span className="employee-profile-movement-result" data-result={movement.result}>{movement.result === "approved" ? "Allowed" : "Denied"}</span></td>
            </tr>;
          })}{movementLoadingMore && <tr><td colSpan={5} className="employee-profile-history-loading" role="status">Loading more movement logs…</td></tr>}</tbody>
        </table>
      </div> : <p className="employee-profile-empty">{historyLoading ? "Loading movement logs…" : "No movement logs recorded."}</p>}
      {movementLogs.length > 0 && movementLogs.length < movementLogCount && <div className="employee-profile-movement-footer">
        <button type="button" disabled={historyLoading || movementLoadingMore} onClick={() => void loadMoreMovementLogs()}>{movementLoadingMore ? "Loading…" : "Load more"}</button>
      </div>}
    </section>
  );

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
        aria-labelledby="employee-profile-identity-title"
        style={{
          "--admin-bg": panelBackground,
          "--admin-text": textColor,
          "--admin-muted": mutedColor,
          "--admin-line": panelLine,
          "--profile-border": borderColor,
          "--profile-card-bg": panelBackground,
          "--profile-shadow": darkTheme ? "0 24px 80px rgba(0, 0, 0, 0.48)" : "0 24px 60px rgba(45, 56, 54, 0.2)",
        } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
        >
        <div className="employee-profile-header">
          <section className="employee-profile-main-header" aria-label={`${person.name} summary`}>
            <div className="employee-profile-identity">
              <h2 id="employee-profile-identity-title">{person.name}</h2>
              <div className="employee-profile-identity-meta">
                <span className="employee-profile-identity-barcode"><ScanLine size={16} aria-hidden="true" />{person.barcode}</span>
                <div className="employee-profile-identity-zones">
                  {assignedZones.length
                    ? assignedZones.map((zone) => <span className="facility-zone-tag" key={zone}>{facilityZoneLabel(zone)}</span>)
                    : <span>No zones assigned</span>}
                </div>
              </div>
            </div>
          </section>
          <div className="employee-profile-period">
            <div className="employee-profile-range-controls" aria-label="Activity date range">
              {(["1W", "1M", "1Y"] as const).map((range) => {
                const isSelected = range === timeRange;
                return (
                  <button key={range} type="button" onClick={() => setTimeRange(range)}
                    className="employee-profile-range-button" aria-pressed={isSelected}>
                    {range}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="employee-profile-header-tools">
            {person.type === "employee" ? <label className="employee-profile-enabled-toggle" data-enabled={employeeEnabled}>
              <input type="checkbox" checked={employeeEnabled} disabled={employeeStatusBusy} onChange={(event) => void setEmployeeStatus(event.target.checked)} />
              <strong>Enabled</strong>
            </label> : null}
            <nav className="employee-profile-header-actions" aria-label="Employee profile actions">
              <Link className="employee-profile-header-action" href={`/admin/permissions?subject=${encodeURIComponent(person.id)}`} aria-label="Manage permissions" title="Manage permissions">
                <ShieldCheck size={19} aria-hidden="true" />
              </Link>
              <Link className="employee-profile-header-action" href={`/admin/logs?tab=alerts&subject=${encodeURIComponent(person.id)}`} aria-label="View alerts" title="View alerts">
                <Bell size={19} aria-hidden="true" />
              </Link>
              <button className="employee-profile-header-action" type="button" onClick={toggleAlertHistory} aria-controls="employee-profile-alert-history" aria-expanded={showAlertHistory} aria-label={showAlertHistory ? "Hide alert history" : "View alert history"} title={showAlertHistory ? "Hide alert history" : "View alert history"}>
                <History size={19} aria-hidden="true" />
              </button>
              <button className="employee-profile-header-action" type="button" onClick={() => void downloadMovementHistory()} disabled={historyLoading || movementLogCount === 0 || exportingHistory} aria-label={exportingHistory ? "Exporting movement history" : "Export movement history as CSV"} title={exportingHistory ? "Exporting movement history" : "Export movement history as CSV"}>
                <Download size={19} aria-hidden="true" />
              </button>
            </nav>
            <button
              className="admin-button admin-button--icon icon-button employee-profile-close"
              type="button"
              onClick={onClose}
              aria-label="Close employee profile"
              title="Close employee profile"
            >
              <X size={20} />
            </button>
          </div>
          {employeeStatusError ? <p className="employee-profile-history-error" role="alert">{employeeStatusError}</p> : null}
        </div>

        <div className="employee-profile-body scrollable-content">
        <div className="employee-profile-content scrollable-content">
          <section className="employee-profile-dashboard-section employee-profile-average-section" aria-label="Average work hours per day" aria-busy={activityLoading}>
            <div className="employee-profile-section-title-row">
              <div>
                <h3>Average daily hours</h3>
                <span className="employee-profile-chart-period">Last {timeRange}</span>
              </div>
              <div className="employee-profile-chart-summary">
                <div className="employee-profile-metric">
                  <div className="employee-profile-summary-number" style={{ color: textColor }}>
                    {activityLoading ? "…" : displayedAverageHours}
                  </div>
                  <div className="employee-profile-summary-label" style={{ color: mutedColor }}>HOURS / DAY</div>
                </div>
              </div>
            </div>
            <div className="employee-profile-hours-chart">
              <div className="employee-profile-hours-chart-canvas">
                <Line data={chartData} options={chartOptions} />
              </div>
            </div>
            {activityError ? <p className="employee-profile-history-error" role="status">{activityError}</p> : null}
          </section>

          <section className="employee-profile-dashboard-section employee-profile-work-pattern-section" aria-label="Work pattern">
            <div className="employee-profile-work-pattern-scroll">
              <WorkPatternChart timeRange={timeRange} sessions={completeSessions} endAt={activity?.endAt} />
            </div>
          </section>

        </div>
        {movementHistory}
        <EmployeeProfileAlerts key={person.id} person={person.type === "employee" ? { ...person, status: employeeEnabled ? "active" : "inactive" } : person} initialAlerts={initialAlerts} showHistory={showAlertHistory} />
        </div>
      </div>
    </div>,
    document.querySelector(".app-shell.role-admin") ?? document.body
  );
}
