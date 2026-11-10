"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Download, ShieldCheck, X } from "lucide-react";
import type { AccessPermission, Alert, Checkpoint, EmployeeActivity, MovementEvent, Person } from "../../../lib/types";
import { readExport } from "../../../lib/exportRead";
import { formatCsvBlob } from "../../../lib/csv";
import type { DayPattern } from "../../../lib/analyticsUtils";
import { normalizeFacilityZones } from "../../../lib/facilityZones";
import { averageWorkedHoursPerDay, employeeActivityPatterns, employeeActivityRangeDays, employeeHoursSeries } from "../../../lib/analyticsQueries";
import { eventTimestamp } from "../../../lib/dateRanges";
import { createReadRefreshGate, createRefreshScheduler } from "../../../lib/refreshScheduler";
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
import { alertGroupDateRange, groupAlertsBySubjectAndType } from "./alerts/alertPresentation";
import "./EmployeeProfileCard.css";

function alertTimestamp(alert: Alert) {
  const created = alert.createdAt ? new Date(alert.createdAt).getTime() : Number.NaN;
  const legacy = new Date(`${alert.date} ${alert.time}`).getTime();
  return Number.isFinite(created) ? created : Number.isFinite(legacy) ? legacy : 0;
}

function formatProfileDate(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  const dateLabel = date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return /[T ]\d{1,2}:\d{2}/.test(value)
    ? `${dateLabel} · ${date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
    : dateLabel;
}

function alertReviewLabel(alert: Alert) {
  if (alert.review?.decision === "excused" || alert.status === "resolved") return "Excused";
  if (alert.review?.decision === "confirmed" || alert.status === "warned") return "Confirmed warning";
  return alert.status === "acknowledged" ? "Needs review" : "Open";
}

const PROFILE_ALERT_LIMIT = 5;
const PROFILE_MOVEMENT_LIMIT = 7;

async function exportMovementCsv(person: Person, movements: MovementEvent[], signal: AbortSignal) {
  if (!movements.length) return;
  const columns: Array<[string, (movement: MovementEvent) => unknown]> = [
    ["Occurred at", (movement) => movement.createdAt || `${movement.date} ${movement.time}`],
    ["Employee", (movement) => movement.subjectName],
    ["Barcode", (movement) => movement.barcode],
    ["Direction", (movement) => movement.direction],
    ["Checkpoint", (movement) => movement.checkpoint],
    ["Result", (movement) => movement.result],
    ["Reason", (movement) => movement.reason || movement.denialCode || ""],
  ];
  const blob = await formatCsvBlob(columns.map(([name]) => name), movements,
    movement => columns.map(([, value]) => value(movement)), { signal, bom: true });
  signal.throwIfAborted();
  const slug = person.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "employee";
  const url = URL.createObjectURL(blob);
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
  checkpoints = [],
  permissions,
  alerts,
  movements,
  onClose,
}: {
  person: Person;
  checkpoints?: Checkpoint[];
  permissions: AccessPermission[];
  sessions: DayPattern[];
  alerts: Alert[];
  movements: MovementEvent[];
  onClose: () => void;
}) {
  const { queryMovements, queryEmployeeActivity, querySubjectProfile, updatePerson } = useDataActions();
  const [timeRange, setTimeRange] = useState<"1Y" | "1M" | "1W">("1W");
  const [mounted, setMounted] = useState(false);
  const [profilePermissions, setProfilePermissions] = useState(() => permissions.filter(permission => permission.subjectId === person.id));
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const initialAlerts = useMemo(() => alerts
    .filter((alert) => alert.subjectId === person.id || (!alert.subjectId && alert.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => alertTimestamp(right) - alertTimestamp(left)), [alerts, person.barcode, person.id]);
  const initialMovements = useMemo(() => movements
    .filter((movement) => movement.subjectId === person.id || (!movement.subjectId && movement.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => eventTimestamp(right) - eventTimestamp(left)), [movements, person.barcode, person.id]);
  const [profileAlerts, setProfileAlerts] = useState<Alert[]>(() => initialAlerts);
  const profileAlertGroups = useMemo(() => groupAlertsBySubjectAndType(profileAlerts), [profileAlerts]);
  const visibleProfileAlertGroups = profileAlertGroups.slice(0, PROFILE_ALERT_LIMIT);
  const visibleProfileAlertCount = visibleProfileAlertGroups.reduce((total, group) => total + group.alerts.length, 0);
  const [alertTriggerCount, setAlertTriggerCount] = useState(initialAlerts.length);
  const [movementLogs, setMovementLogs] = useState<MovementEvent[]>(() => initialMovements);
  const [movementLogCount, setMovementLogCount] = useState(initialMovements.length);
  const [movementNextPage, setMovementNextPage] = useState(2);
  const [movementLoadingMore, setMovementLoadingMore] = useState(false);
  const movementMorePending = useRef(false);
  const movementMoreController = useRef<AbortController | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [profileRevision, setProfileRevision] = useState(0);
  const profileRefreshGate = useMemo(() => createReadRefreshGate(() => setProfileRevision(value => value + 1)), [person.id]);
  const profileRefreshScheduler = useMemo(() => createRefreshScheduler(() => profileRefreshGate.request()), [profileRefreshGate]);
  const [exportingHistory, setExportingHistory] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const exportPending = useRef(false);
  useEffect(() => () => exportController.current?.abort(), []);
  const historyPerson = useRef(person.id);
  const [activity, setActivity] = useState<EmployeeActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState("");
  const [employeeEnabled, setEmployeeEnabled] = useState(person.type === "employee" && person.status === "active");
  const [employeeStatusBusy, setEmployeeStatusBusy] = useState(false);
  const [employeeStatusError, setEmployeeStatusError] = useState("");
  const darkTheme = useAdminTheme() === "dark";
  const assignedZones = normalizeFacilityZones(person.allowedZones);
  const allowsEveryZone = assignedZones.some((zone) => zone.trim().toLowerCase() === "all zones");
  const checkpointById = useMemo(() => new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])), [checkpoints]);
  const checkpointLabel = useCallback((checkpointId: string) => {
    const checkpoint = checkpointById.get(checkpointId);
    return checkpoint?.gateLabel || checkpoint?.name || checkpointId;
  }, [checkpointById]);
  const assignedCheckpointLabels = useMemo(() => {
    const explicitIds = person.allowedCheckpoints?.length ? new Set(person.allowedCheckpoints) : null;
    if (explicitIds) return [...explicitIds].map(checkpointLabel);
    return checkpoints
      .filter((checkpoint) => checkpoint.active !== false && (allowsEveryZone || assignedZones.includes(checkpoint.zoneId ?? checkpoint.zone)))
      .map((checkpoint) => checkpoint.gateLabel || checkpoint.name);
  }, [allowsEveryZone, assignedZones, checkpoints, checkpointLabel, person.allowedCheckpoints]);
  const permissionCheckpointLabels = useCallback((permission: AccessPermission) => {
    if (permission.checkpoints) return permission.checkpoints.map(checkpointLabel);
    const permissionZones = normalizeFacilityZones(permission.zones);
    const allowsAll = permissionZones.some((zone) => zone.trim().toLowerCase() === "all zones");
    if (!permissionZones.length && !allowsAll) return [];
    return checkpoints
      .filter((checkpoint) => checkpoint.active !== false && (allowsAll || permissionZones.includes(checkpoint.zoneId ?? checkpoint.zone)))
      .map((checkpoint) => checkpoint.gateLabel || checkpoint.name);
  }, [checkpoints, checkpointLabel]);
  const updateAlertHistory = useCallback((items: Alert[], total: number) => {
    setProfileAlerts(items);
    setAlertTriggerCount(total);
  }, []);
  const subjectMovementRevision = useMemo(() => initialMovements.map(movement =>
    [movement.id, movement.result, movement.direction, movement.scanType, movement.createdAt, movement.manualReviewedAt].join(":"))
    .join("|"), [initialMovements]);
  const observedMovements = useRef({ personId: person.id, revision: subjectMovementRevision });
  useEffect(() => {
    const previous = observedMovements.current;
    observedMovements.current = { personId: person.id, revision: subjectMovementRevision };
    if (previous.personId === person.id && previous.revision !== subjectMovementRevision) profileRefreshScheduler.request();
  }, [person.id, subjectMovementRevision, profileRefreshScheduler]);

  useEffect(() => {
    const refresh = () => profileRefreshScheduler.request();
    const receive = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        if (update.type === "data_changed" || update.subject_id === person.id || update.movement?.subjectId === person.id ||
          update.permission?.subjectId === person.id || update.request?.subjectId === person.id) refresh();
      } catch { /* A reconnect reconciles malformed events. */ }
    };
    window.addEventListener("inout:presence-message", receive);
    window.addEventListener("inout:presence-sync", refresh);
    return () => { profileRefreshScheduler.cancel(); profileRefreshGate.cancel(); window.removeEventListener("inout:presence-message", receive); window.removeEventListener("inout:presence-sync", refresh); };
  }, [person.id, profileRefreshScheduler, profileRefreshGate]);

  useEffect(() => {
    const controller = new AbortController();
    const finishRead = profileRefreshGate.begin();
    profileRefreshScheduler.cancel();
    setPermissionsLoading(true);
    void querySubjectProfile(person.id, controller.signal)
      .then(profile => { if (!controller.signal.aborted) setProfilePermissions(profile.permissions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))); })
      .catch(() => { if (!controller.signal.aborted) setHistoryError("Permissions could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setPermissionsLoading(false); finishRead(); });
    return () => { controller.abort(); finishRead(); };
  }, [person.id, querySubjectProfile, profileRevision, profileRefreshGate, profileRefreshScheduler]);

  async function downloadMovementHistory() {
    if (exportPending.current) return;
    exportPending.current = true;
    setExportingHistory(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    exportController.current = controller;
    try {
      const result = await readExport<{ items: MovementEvent[] }>("movements", { subject_id: person.id }, controller.signal);
      await exportMovementCsv(person, result.items, controller.signal);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "Unable to export movement history."); }
    finally { clearTimeout(timer); exportPending.current = false; setExportingHistory(false); }
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

  const loadMoreMovementLogs = useCallback(async () => {
    if (historyLoading || movementLoadingMore || movementMorePending.current || movementLogs.length >= movementLogCount) return;
    const controller = new AbortController();
    movementMoreController.current?.abort();
    movementMoreController.current = controller;
    movementMorePending.current = true;
    setMovementLoadingMore(true);
    try {
      const page = await queryMovements({ page: movementNextPage, pageSize: PROFILE_MOVEMENT_LIMIT, subject_id: person.id, includeChart: false }, controller.signal);
      if (controller.signal.aborted || historyPerson.current !== person.id) return;
      setMovementLogs((current) => {
        const existingIds = new Set(current.map((movement) => movement.id));
        return [...current, ...page.items.filter((movement) => !existingIds.has(movement.id))];
      });
      setMovementLogCount(page.total);
      setMovementNextPage(page.page + 1);
    } catch {
      if (!controller.signal.aborted) setHistoryError("More movement history could not be loaded.");
    } finally {
      if (movementMoreController.current === controller) movementMoreController.current = null;
      if (!controller.signal.aborted) {
        movementMorePending.current = false;
        setMovementLoadingMore(false);
      }
    }
  }, [historyLoading, movementLoadingMore, movementLogs.length, movementLogCount, movementNextPage, person.id, queryMovements]);

  useEffect(() => {
    const movementLoadController = new AbortController();
    const finishRead = profileRefreshGate.begin();
    movementMoreController.current?.abort();
    movementMoreController.current = null;
    movementMorePending.current = false;
    setMovementLoadingMore(false);
    setMovementNextPage(2);
    setHistoryLoading(true);
    setHistoryError("");
    if (historyPerson.current !== person.id) {
      historyPerson.current = person.id;
      setMovementLogs([]);
      setMovementLogCount(0);
    }
    void queryMovements({ page: 1, pageSize: PROFILE_MOVEMENT_LIMIT, subject_id: person.id, includeChart: false }, movementLoadController.signal)
      .then(page => {
        if (movementLoadController.signal.aborted) return;
        setMovementLogs(page.items);
        setMovementLogCount(page.total);
      }).catch(() => { if (!movementLoadController.signal.aborted) setHistoryError("Some movement history could not be loaded."); })
      .finally(() => { if (!movementLoadController.signal.aborted) setHistoryLoading(false); finishRead(); });
    return () => {
      movementLoadController.abort();
      movementMoreController.current?.abort();
      finishRead();
    };
  }, [person.id, queryMovements, profileRevision, profileRefreshGate]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const finishRead = profileRefreshGate.begin();
    setActivity(null);
    setActivityLoading(true);
    setActivityError("");
    void queryEmployeeActivity({ subjectId: person.id, days: timeRange === "1Y" ? 365 : timeRange === "1M" ? 30 : 7 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setActivity(result); })
      .catch(() => { if (!controller.signal.aborted) setActivityError("Worked hours could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setActivityLoading(false); finishRead(); });
    return () => { controller.abort(); finishRead(); };
  }, [person.id, timeRange, queryEmployeeActivity, profileRevision, profileRefreshGate]);

  const { labels, dataPoints } = useMemo(() => activity
    ? employeeHoursSeries(activity, timeRange) : { labels: [], dataPoints: [] }, [activity, timeRange]);
  const completeSessions = useMemo(() => activity ? employeeActivityPatterns(activity) : [], [activity]);
  const periodDays = employeeActivityRangeDays(timeRange);
  const averageHoursPerDay = activity ? averageWorkedHoursPerDay(activity.days, periodDays) : null;
  const displayedAverageHours = averageHoursPerDay === null ? "—" : averageHoursPerDay.toFixed(1);
  const panelBackground = darkTheme ? "#0f1413" : "rgb(237, 242, 240)";
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
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
            event.stopPropagation();
          }
        }}
        >
        <div className="employee-profile-header">
          <div className="employee-profile-main-header">
            <div className="employee-profile-identity">
              <h2 id="employee-profile-identity-title">{person.name}</h2>
              <div className="employee-profile-identity-meta">
                <span className="employee-profile-identity-barcode">Barcode: {person.barcode}</span>
                <span className="employee-profile-identity-checkpoints" aria-label="Assigned checkpoints">
                  <span className="employee-profile-identity-checkpoints-label">Checkpoints:</span>
                  {assignedCheckpointLabels.length
                    ? assignedCheckpointLabels.map((checkpoint) => <span className="checkpoint-tag" key={checkpoint}>{checkpoint}</span>)
                    : "No checkpoints assigned"}
                </span>
              </div>
            </div>
          </div>
          <div className="employee-profile-period">
            <div className="employee-profile-range-controls" role="group" aria-label="Profile time range">
              {(["1Y", "1M", "1W"] as const).map((range) => {
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
            <button
              className="admin-button admin-button--icon icon-button employee-profile-close"
              type="button"
              onClick={onClose}
              aria-label="Close employee profile"
              title="Close employee profile"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          {employeeStatusError ? <p className="employee-profile-history-error" role="alert">{employeeStatusError}</p> : null}
        </div>

        <div className="employee-profile-body scrollable-content">
          <div className="employee-profile-content">
            <section className="employee-profile-average-section" aria-labelledby="employee-profile-average-title" aria-busy={activityLoading}>
              <div className="employee-profile-section-title-row">
                <div>
                  <h3 id="employee-profile-average-title">Average working hours</h3>
                  <span className="employee-profile-chart-period">Per day · {timeRange}</span>
                </div>
              </div>
              <div className="employee-profile-chart-summary">
                <div>
                  <div className="employee-profile-summary-number" style={{ color: textColor }}>
                    {activityLoading ? "…" : displayedAverageHours}
                  </div>
                  <div className="employee-profile-summary-label" style={{ color: mutedColor }}>
                    HOURS PER DAY
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

            <section className="employee-profile-movement-section" aria-labelledby="employee-profile-movements-title">
              <div className="employee-profile-movement-header">
                <h3 id="employee-profile-movements-title">Movement logs</h3>
                <button
                  className="admin-button admin-button--ghost ghost-button"
                  type="button"
                  onClick={() => void downloadMovementHistory()}
                  disabled={historyLoading || movementLogCount === 0 || exportingHistory}
                  title="Export complete movement history as CSV"
                >
                  <Download size={16} aria-hidden="true" /> {exportingHistory ? "Exporting…" : "Export CSV"}
                </button>
              </div>
              {movementLogs.length ? <div className="employee-profile-movement-table-wrap" role="region" aria-label="Movement history" tabIndex={0} onScroll={(event) => {
                const element = event.currentTarget;
                if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadMoreMovementLogs();
              }}>
                <table className="employee-profile-movement-table">
                  <caption className="sr-only">Movement history for {person.name}</caption>
                  <thead><tr><th scope="col">Date &amp; time</th><th scope="col">Direction</th><th scope="col">Checkpoint</th><th scope="col">Result</th><th scope="col">Scan</th><th scope="col">Details</th></tr></thead>
                  <tbody>{movementLogs.map((movement) => {
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
                  })}{movementLoadingMore && <tr><td colSpan={6} className="employee-profile-history-loading" role="status">Loading more movement logs…</td></tr>}</tbody>
                </table>
              </div> : <p className="employee-profile-empty">{historyLoading ? "Loading movement logs…" : "No movement logs recorded."}</p>}
              {movementLogs.length > 0 && movementLogs.length < movementLogCount ? <div className="employee-profile-movement-footer">
                <span>{movementLogs.length} of {movementLogCount} records</span>
                <button type="button" disabled={historyLoading || movementLoadingMore} onClick={() => void loadMoreMovementLogs()}>{movementLoadingMore ? "Loading…" : "Load more"}</button>
              </div> : null}
            </section>

            <section className="employee-profile-utilities" aria-label="Employee permissions and alert summary">
              {historyError ? <p className="employee-profile-history-error" role="status">{historyError}</p> : null}
              <dl className="employee-profile-summary-grid" aria-label="Employee record counts">
                <div className="employee-profile-summary-item"><dt>Permissions</dt><dd>{permissionsLoading ? "…" : profilePermissions.length}</dd></div>
                <div className="employee-profile-summary-item"><dt>Alert triggers</dt><dd>{alertTriggerCount}</dd></div>
                <div className="employee-profile-summary-item"><dt>Movement logs</dt><dd>{movementLogCount}</dd></div>
              </dl>
              <div className="employee-profile-record-grid">
                <section className="employee-profile-record-section scrollable-content" aria-labelledby="employee-profile-permissions-title">
                  <div className="employee-profile-record-section-heading">
                    <h3 id="employee-profile-permissions-title">Employee permissions</h3>
                    <Link className="employee-profile-manage-permission" href={`/admin/permissions?subject=${encodeURIComponent(person.id)}`}>
                      <ShieldCheck size={16} aria-hidden="true" />Manage permissions<ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                  {profilePermissions.length ? <ul className="employee-profile-record-list">
                    {profilePermissions.slice(0, 3).map((permission) => {
                      const labels = permissionCheckpointLabels(permission);
                      const scope = labels.length
                        ? `Checkpoints: ${labels.join(" · ")}`
                        : permission.checkpoints !== undefined || permission.zones.length
                          ? "No checkpoints assigned"
                          : permission.assignment;
                      return <li key={permission.id}>
                        <div className="employee-profile-record-heading"><strong>{scope}</strong><span data-state={permission.state}>{permission.state.replaceAll("_", " ")}</span></div>
                        <small>{formatProfileDate(permission.validFrom)} – {permission.validTo ? formatProfileDate(permission.validTo) : "No expiry"}</small>
                        {permission.reason ? <p>{permission.reason}</p> : null}
                      </li>;
                    })}
                  </ul> : <p className="employee-profile-empty">{permissionsLoading ? "Loading permissions…" : "No individual permission records."}</p>}
                  {profilePermissions.length > 3 ? <p className="employee-profile-more-count">+{profilePermissions.length - 3} more</p> : null}
                </section>

                <section className="employee-profile-record-section employee-profile-alert-section" aria-labelledby="employee-profile-alert-triggers-title">
                  <div className="employee-profile-record-section-heading">
                    <h3 id="employee-profile-alert-triggers-title">Alert triggers</h3>
                    <Link className="employee-profile-manage-permission" href={`/admin/logs?tab=alerts&subject=${encodeURIComponent(person.id)}`}>
                      View alerts<ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                  {profileAlertGroups.length ? <ul className="employee-profile-record-list">
                    {visibleProfileAlertGroups.map((group) => {
                      const alert = group.alerts[0];
                      const reviewLabels = [...new Set(group.alerts.map(alertReviewLabel))];
                      const state = reviewLabels.length === 1 ? alert.review?.decision ?? alert.status : "mixed";
                      return <li key={group.key}>
                        <div className="employee-profile-record-heading"><strong>{alert.title}</strong><span data-state={state}>{group.alerts.length > 1 ? `${group.alerts.length} occurrences` : alertReviewLabel(alert)}</span></div>
                        <small>{group.alerts.length > 1 ? alertGroupDateRange(group.alerts) : formatProfileDate(alert.createdAt || `${alert.date} ${alert.time}`)}{alert.severity !== "medium" ? ` · ${alert.severity}` : ""}</small>
                      </li>;
                    })}
                  </ul> : <p className="employee-profile-empty">{historyLoading ? "Loading alert history…" : "No alert triggers recorded."}</p>}
                  {Math.max(alertTriggerCount, profileAlerts.length) > visibleProfileAlertCount ? <p className="employee-profile-more-count">+{Math.max(alertTriggerCount, profileAlerts.length) - visibleProfileAlertCount} more alert occurrences</p> : null}
                </section>
              </div>
            </section>

            <section className="employee-profile-work-pattern-section" aria-label="Employee work pattern">
              <div className="employee-profile-work-pattern-scroll scrollable-content">
                <WorkPatternChart timeRange={timeRange} sessions={completeSessions} endAt={activity?.endAt} />
              </div>
            </section>

            <div className="employee-profile-open-alerts-section">
              <EmployeeProfileAlerts key={person.id} person={person.type === "employee" ? { ...person, status: employeeEnabled ? "active" : "inactive" } : person} initialAlerts={initialAlerts} onHistoryChanged={updateAlertHistory} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.querySelector(".app-shell.role-admin") ?? document.body
  );
}
