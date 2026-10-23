"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Download, ShieldCheck, X } from "lucide-react";
import type { AccessPermission, Alert, EmployeeActivity, MovementEvent, Person } from "../../../lib/types";
import { assertCsvBound, readExport } from "../../../lib/exportRead";
import type { DayPattern } from "../../../lib/analyticsUtils";
import { facilityZoneLabel, normalizeFacilityZones } from "../../../lib/facilityZones";
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
  return alert.status === "acknowledged" ? "Needs review" : "Open";
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

const PROFILE_ALERT_PAGE_SIZE = 100;
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
  const { queryAlerts, queryMovements, queryEmployeeActivity, querySubjectProfile, updatePerson } = useDataActions();
  const [timeRange, setTimeRange] = useState<"1Y" | "1M" | "1W">("1W");
  const [mounted, setMounted] = useState(false);
  const [profilePermissions, setProfilePermissions] = useState(() => permissions.filter(permission => permission.subjectId === person.id));
  const initialAlerts = useMemo(() => alerts
    .filter((alert) => alert.subjectId === person.id || (!alert.subjectId && alert.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => alertTimestamp(right) - alertTimestamp(left)), [alerts, person.barcode, person.id]);
  const initialMovements = useMemo(() => movements
    .filter((movement) => movement.subjectId === person.id || (!movement.subjectId && movement.barcode.toLowerCase() === person.barcode.toLowerCase()))
    .sort((left, right) => eventTimestamp(right) - eventTimestamp(left)), [movements, person.barcode, person.id]);
  const [profileAlerts, setProfileAlerts] = useState<Alert[]>(() => initialAlerts);
  const [alertTriggerCount, setAlertTriggerCount] = useState(initialAlerts.length);
  const [alertTriggerOffset, setAlertTriggerOffset] = useState(0);
  const [alertTriggersLoadingMore, setAlertTriggersLoadingMore] = useState(false);
  const alertTriggerPending = useRef(false);
  const alertTriggerController = useRef<AbortController | null>(null);
  const [movementLogs, setMovementLogs] = useState<MovementEvent[]>(() => initialMovements);
  const [movementLogCount, setMovementLogCount] = useState(initialMovements.length);
  const [entryMovementCount, setEntryMovementCount] = useState<number | null>(null);
  const [exitMovementCount, setExitMovementCount] = useState<number | null>(null);
  const [alertMetrics, setAlertMetrics] = useState<{ openAlerts: number; confirmedWarnings: number } | null>(null);
  const [movementNextPage, setMovementNextPage] = useState(2);
  const [movementLoadingMore, setMovementLoadingMore] = useState(false);
  const movementMorePending = useRef(false);
  const movementMoreController = useRef<AbortController | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [profileRevision, setProfileRevision] = useState(0);
  const [exportingHistory, setExportingHistory] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => {
    exportController.current?.abort();
    alertTriggerController.current?.abort();
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
  const updateAlertHistory = useCallback((items: Alert[], total: number) => {
    setAlertTriggerCount(total);
    if (total === 0) {
      setProfileAlerts([]);
      setAlertTriggerOffset(0);
      return;
    }
    setProfileAlerts((current) => {
      const merged = new Map<string, Alert>(current.map((alert) => [alert.id, alert] as const));
      items.forEach((alert) => merged.set(alert.id, alert));
      return [...merged.values()].sort((left, right) => alertTimestamp(right) - alertTimestamp(left));
    });
  }, []);
  const updateAlertMetrics = useCallback((metrics: { openAlerts: number; confirmedWarnings: number }) => {
    setAlertMetrics(metrics);
  }, []);
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

  useEffect(() => {
    const controller = new AbortController();
    void querySubjectProfile(person.id, controller.signal)
      .then(profile => { if (!controller.signal.aborted) setProfilePermissions(profile.permissions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))); })
      .catch(() => { if (!controller.signal.aborted) setHistoryError("Permissions could not be loaded."); });
    return () => controller.abort();
  }, [person.id, querySubjectProfile, profileRevision]);

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
    setEntryMovementCount(null);
    setExitMovementCount(null);
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
    void Promise.all([
      queryMovements({ page: 1, pageSize: 1, subject_id: person.id, direction: "entry", includeChart: false }, movementLoadController.signal),
      queryMovements({ page: 1, pageSize: 1, subject_id: person.id, direction: "exit", includeChart: false }, movementLoadController.signal),
    ]).then(([entries, exits]) => {
      if (movementLoadController.signal.aborted) return;
      setEntryMovementCount(entries.total);
      setExitMovementCount(exits.total);
    }).catch(() => {
      if (!movementLoadController.signal.aborted) {
        setEntryMovementCount(null);
        setExitMovementCount(null);
      }
    });
    return () => movementLoadController.abort();
  }, [person.id, queryMovements, subjectMovementRevision, profileRevision]);

  useEffect(() => {
    const controller = new AbortController();
    alertTriggerController.current?.abort();
    alertTriggerPending.current = false;
    setAlertTriggersLoadingMore(false);
    setProfileAlerts(initialAlerts);
    setAlertTriggerCount(initialAlerts.length);
    setAlertTriggerOffset(0);
    setHistoryError("");
    void queryAlerts({ view: "subject", subjectId: person.id, limit: PROFILE_ALERT_PAGE_SIZE, offset: 0, sortDirection: "desc" }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setProfileAlerts(page.items);
        setAlertTriggerCount(page.totalSubjectAlerts ?? page.total);
        setAlertTriggerOffset(page.items.length);
      })
      .catch(() => { if (!controller.signal.aborted) setHistoryError("Some alert history could not be loaded."); });
    return () => controller.abort();
  }, [person.id, queryAlerts, initialAlerts, profileRevision]);

  const loadMoreAlertTriggers = useCallback(async () => {
    if (alertTriggerPending.current || alertTriggerOffset >= alertTriggerCount) return;
    const controller = new AbortController();
    alertTriggerController.current?.abort();
    alertTriggerController.current = controller;
    alertTriggerPending.current = true;
    setAlertTriggersLoadingMore(true);
    try {
      const page = await queryAlerts({
        view: "subject", subjectId: person.id, limit: PROFILE_ALERT_PAGE_SIZE,
        offset: alertTriggerOffset, sortDirection: "desc",
      }, controller.signal);
      if (controller.signal.aborted) return;
      setProfileAlerts((current) => {
        const merged = new Map<string, Alert>(current.map((alert) => [alert.id, alert] as const));
        page.items.forEach((alert) => merged.set(alert.id, alert));
        return [...merged.values()].sort((left, right) => alertTimestamp(right) - alertTimestamp(left));
      });
      setAlertTriggerCount(page.totalSubjectAlerts ?? page.total);
      setAlertTriggerOffset((current) => current + page.items.length);
    } catch (cause) {
      if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "Some alert history could not be loaded.");
    } finally {
      if (alertTriggerController.current === controller) {
        alertTriggerPending.current = false;
        setAlertTriggersLoadingMore(false);
      }
    }
  }, [alertTriggerCount, alertTriggerOffset, person.id, queryAlerts]);

  const loadMoreMovementLogs = useCallback(async () => {
    if (movementMorePending.current || movementLogs.length >= movementLogCount) return;
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
  }, [movementLogCount, movementLogs.length, movementNextPage, person.id, queryMovements]);

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
          {person.type === "employee" && <label className="employee-profile-enabled-toggle" data-enabled={employeeEnabled}>
            <input type="checkbox" checked={employeeEnabled} disabled={employeeStatusBusy} onChange={(event) => void setEmployeeStatus(event.target.checked)} />
            <strong>Enabled</strong>
          </label>}
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

        <div className="employee-profile-body scrollable-content">
        <section className="employee-profile-main-header" aria-label={`${person.name} profile summary`}>
          <div className="employee-profile-header-metrics employee-profile-header-metrics--movement" aria-label="Movement summary">
            <article className="employee-profile-metric"><span>Total movements</span><strong>{historyLoading ? "…" : movementLogCount}</strong></article>
            <article className="employee-profile-metric"><span>Entries</span><strong>{entryMovementCount ?? "…"}</strong></article>
            <article className="employee-profile-metric"><span>Exits</span><strong>{exitMovementCount ?? "…"}</strong></article>
          </div>
          <div className="employee-profile-identity">
            <h2>{person.name}</h2>
            <div className="employee-profile-identity-barcode">{person.barcode}</div>
            <div className="employee-profile-identity-zones">
              {assignedZones.length
                ? assignedZones.map((zone) => <span className="facility-zone-tag" key={zone}>{facilityZoneLabel(zone)}</span>)
                : <span>No zones assigned</span>}
            </div>
          </div>
          <div className="employee-profile-header-metrics employee-profile-header-metrics--alerts" aria-label="Alert and warning summary">
            <article className="employee-profile-metric"><span>Alert triggers</span><strong>{alertTriggerCount}</strong></article>
            <article className="employee-profile-metric"><span>Open alerts</span><strong>{alertMetrics?.openAlerts ?? "…"}</strong></article>
            <article className="employee-profile-metric"><span>Confirmed warnings</span><strong>{alertMetrics?.confirmedWarnings ?? "…"}</strong></article>
          </div>
        </section>
        <div className="employee-profile-content scrollable-content">
          {employeeStatusError ? <p className="employee-profile-history-error" role="alert">{employeeStatusError}</p> : null}

          <div className="employee-profile-hours-chart" aria-busy={activityLoading}>
            <div className="employee-profile-chart-summary">
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px", textAlign: "left" }}>
                <div className="employee-profile-summary-number" style={{ color: textColor }}>
                  {activityLoading ? "…" : displayedAverageHours}
                </div>
                <div className="employee-profile-summary-label" style={{ color: mutedColor }}>
                  AVG HOURS / DAY · {timeRange}
                </div>
              </div>
            </div>
            
            <div className="employee-profile-hours-chart-canvas">
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>

          <div className="employee-profile-work-pattern">
            <WorkPatternChart timeRange={timeRange} sessions={completeSessions} endAt={activity?.endAt} />
          </div>
          {activityError ? <p className="employee-profile-history-error" role="status">{activityError}</p> : null}

          <div className="employee-profile-record-grid">
            <section className="employee-profile-record-section scrollable-content" aria-labelledby="employee-profile-permissions-title">
              <div className="employee-profile-record-section-heading">
                <h3 id="employee-profile-permissions-title">Employee permissions</h3>
                <Link
                  className="employee-profile-manage-permission"
                  href={`/admin/permissions?subject=${encodeURIComponent(person.id)}`}
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  Manage permissions
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              </div>
              {profilePermissions.length ? <ul className="employee-profile-record-list">
                {profilePermissions.map((permission) => <li key={permission.id}>
                  <div className="employee-profile-record-heading"><strong>{permission.zones.length ? normalizeFacilityZones(permission.zones).map(facilityZoneLabel).join(" · ") : permission.assignment}</strong><span data-state={permission.state}>{permission.state.replaceAll("_", " ")}</span></div>
                  <small>{formatProfileDate(permission.validFrom)} – {permission.validTo ? formatProfileDate(permission.validTo) : "No expiry"}</small>
                  {permission.reason ? <p>{permission.reason}</p> : null}
                </li>)}
              </ul> : <p className="employee-profile-empty">No individual permission records.</p>}
            </section>

              <section className="employee-profile-record-section employee-profile-alert-section" aria-labelledby="employee-profile-alert-triggers-title">
                <div className="employee-profile-record-section-heading">
                  <h3 id="employee-profile-alert-triggers-title">Alert triggers</h3>
                  <Link
                    className="employee-profile-manage-permission"
                    href={`/admin/logs?tab=alerts&subject=${encodeURIComponent(person.id)}`}
                  >
                    View alerts
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                </div>
                {profileAlerts.length ? <ul className="employee-profile-record-list employee-profile-alert-trigger-list" aria-busy={alertTriggersLoadingMore} onScroll={(event) => {
                  const element = event.currentTarget;
                  if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadMoreAlertTriggers();
                }} aria-label="Alert trigger history">
                  {profileAlerts.map((alert) => <li key={alert.id}>
                    <div className="employee-profile-record-heading"><strong>{alert.title}</strong><span data-state={alert.review?.decision ?? alert.status}>{alertReviewLabel(alert)}</span></div>
                    <small>{formatProfileDate(alert.createdAt || `${alert.date} ${alert.time}`)}{alert.severity !== "medium" ? ` · ${alert.severity}` : ""}</small>
                  </li>)}
                  {alertTriggersLoadingMore && <li className="employee-profile-history-loading" role="status">Loading more alerts…</li>}
                </ul> : <p className="employee-profile-empty">{historyLoading ? "Loading alert history…" : "No alert triggers recorded."}</p>}
              </section>

            <section className="employee-profile-record-section employee-profile-movement-section scrollable-content" aria-labelledby="employee-profile-movements-title">
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
              {movementLogs.length ? <div className="employee-profile-movement-table-wrap" onScroll={(event) => {
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
            </section>
          </div>
          {historyError ? <p className="employee-profile-history-error" role="status">{historyError}</p> : null}
        </div>
        <EmployeeProfileAlerts key={person.id} person={person.type === "employee" ? { ...person, status: employeeEnabled ? "active" : "inactive" } : person} initialAlerts={initialAlerts} onHistoryChanged={updateAlertHistory} onMetricsChange={updateAlertMetrics} />
        </div>
      </div>
    </div>,
    document.querySelector(".app-shell.role-admin") ?? document.body
  );
}
