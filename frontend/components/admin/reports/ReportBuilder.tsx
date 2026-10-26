"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  CalendarDays,
  Download,
  FileBarChart,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Alert, AuditEvent, MovementEvent, MovementQuery } from "../../../../lib/types";
import { CalendarDatePicker } from "../../analytics/CalendarDatePicker";
import { parseDateInput } from "../../../../lib/dateRanges";
import { escapeCsv } from "../../../../lib/csv";
import { assertCsvBound, readExport } from "../../../../lib/exportRead";
import { facilityToday, validateHistoricalDateRange } from "../../../../lib/dateTimeValidation";
import { normalizeCheckpointLabel } from "../../../../lib/normalizeDashboard";
import styles from "./ReportBuilder.module.css";

const RESTRICTED_DENIAL_CODES = new Set([
  "asset_restricted",
  "access_restricted",
  "hardware_restricted",
  "zone_not_permitted",
  "cross_building_access",
  "expired_pass",
]);

type ReportSource = "movements" | "alerts" | "permissions";

type ReportRow = {
  source: string;
  date: string;
  time: string;
  subject: string;
  outcome: string;
  details: string;
  reference: string;
};

const SOURCE_LABELS: Record<ReportSource, string> = {
  movements: "Movements",
  alerts: "Alerts",
  permissions: "Permissions",
};

function parseReportDate(date: string, time: string, createdAt?: string) {
  const createdTimestamp = createdAt ? new Date(createdAt).getTime() : NaN;
  const parsed = Number.isFinite(createdTimestamp)
    ? createdTimestamp
    : new Date(`${date} ${time}`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ReportBuilder({
  movements,
  alerts,
  auditEvents,
  activeSource,
  checkpoints,
}: {
  movements: MovementEvent[];
  alerts: Alert[];
  auditEvents: AuditEvent[];
  activeSource: ReportSource;
  checkpoints: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [dateRangeValid, setDateRangeValid] = useState(true);
  const [rangePresetRevision, setRangePresetRevision] = useState(0);
  const [movementCheckpoint, setMovementCheckpoint] = useState("all");
  const [movementSubjectGroup, setMovementSubjectGroup] = useState<"all" | NonNullable<MovementQuery["subjectGroup"]>>("all");
  const [movementResult, setMovementResult] = useState<"all" | "approved" | "denied">("all");
  const [movementDirection, setMovementDirection] = useState<"all" | "entry" | "exit">("all");
  const [movementScanType, setMovementScanType] = useState<"all" | "auto" | "manual">("all");
  const [movementDenialCategory, setMovementDenialCategory] = useState<"all" | NonNullable<MovementQuery["denialCategory"]>>("all");
  const [alertStatus, setAlertStatus] = useState<"all" | "active" | Alert["status"]>("all");
  const [alertSeverity, setAlertSeverity] = useState<"all" | Alert["severity"]>("all");
  const [permissionDecision, setPermissionDecision] = useState<"all" | "granted" | "denied">("all");
  const [generated, setGenerated] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [generationError, setGenerationError] = useState("");
  const [reportMovements, setReportMovements] = useState(movements);
  const [reportAlerts, setReportAlerts] = useState(alerts);
  const [reportAuditEvents, setReportAuditEvents] = useState(auditEvents);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      exportController.current?.abort();
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    setGenerated(false);
    setGenerationError("");
  }, [activeSource]);

  const rows = useMemo(() => {
    const start = startDate ? parseDateInput(startDate) ?? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const end = endDate ? Math.min(parseDateInput(endDate, true) ?? Number.NEGATIVE_INFINITY, Date.now()) : Date.now();
    const reportRows: Array<ReportRow & { timestamp: number }> = [];

    if (activeSource === "movements") {
      for (const movement of reportMovements) {
        if (movementCheckpoint !== "all" && movement.checkpoint !== movementCheckpoint) continue;
        if (movementSubjectGroup === "people" && movement.subjectType === "hardware") continue;
        if (movementSubjectGroup === "hardware" && movement.subjectType !== "hardware") continue;
        if (movementResult !== "all" && movement.result !== movementResult) continue;
        if (movementDirection !== "all" && movement.direction !== movementDirection) continue;
        if (movementScanType !== "all" && movement.scanType !== movementScanType) continue;
        if (movementDenialCategory !== "all" && (
          movement.result !== "denied" ||
          (movementDenialCategory === "restricted"
            ? !RESTRICTED_DENIAL_CODES.has(movement.denialCode ?? "")
            : RESTRICTED_DENIAL_CODES.has(movement.denialCode ?? ""))
        )) continue;
        reportRows.push({
          source: "Movement",
          date: movement.date,
          time: movement.time,
          subject: movement.subjectName,
          outcome: movement.result,
          details: `${movement.direction} / ${normalizeCheckpointLabel(movement.checkpoint)}${movement.carrierName ? ` / Carried by ${movement.carrierName}` : ""}${movement.sourceEventId ? ` / Scan ${movement.sourceEventId}` : ""}${movement.reason && movement.reason !== "-" ? ` / ${movement.reason}` : ""}`,
          reference: movement.id,
          timestamp: parseReportDate(movement.date, movement.time, movement.createdAt),
        });
      }
    }

    if (activeSource === "alerts") {
      for (const alert of reportAlerts) {
        if (alertStatus !== "all" && (alertStatus === "active"
          ? alert.status !== "open" && alert.status !== "warned"
          : alert.status !== alertStatus)) continue;
        if (alertSeverity !== "all" && alert.severity !== alertSeverity) continue;
        reportRows.push({
          source: "Alert",
          date: alert.date,
          time: alert.time,
          subject: alert.subjectName,
          outcome: `${alert.severity} / ${alert.status}`,
          details: `${alert.title} / ${alert.reason}`,
          reference: alert.id,
          timestamp: parseReportDate(alert.date, alert.time, alert.createdAt),
        });
      }
    }

    if (activeSource === "permissions") {
      for (const audit of reportAuditEvents) {
        if (audit.category !== "permission" || !audit.decision) continue;
        if (permissionDecision !== "all" && audit.decision !== permissionDecision) continue;
        reportRows.push({
          source: "Manual permission",
          date: audit.date,
          time: audit.time,
          subject: audit.subjectName,
          outcome: audit.decision,
          details: `${audit.action} / ${audit.reason} / ${audit.actor}`,
          reference: audit.id,
          timestamp: parseReportDate(audit.date, audit.time, audit.createdAt),
        });
      }
    }

    return reportRows
      .filter((row) => Number.isFinite(row.timestamp) && row.timestamp > 0 && row.timestamp >= start && row.timestamp <= end)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(({ timestamp: _timestamp, ...row }) => row);
  }, [activeSource, alertSeverity, alertStatus, endDate, movementCheckpoint, movementDenialCategory, movementDirection, movementResult, movementScanType, movementSubjectGroup, permissionDecision, reportAlerts, reportAuditEvents, reportMovements, startDate]);

  async function generateReport() {
    if (isGenerating || !dateRangeValid) return;
    const dateErrors = validateHistoricalDateRange(startDate, endDate);
    if (dateErrors.start || dateErrors.end) {
      setGenerationError(dateErrors.start || dateErrors.end || "Choose a valid date range.");
      return;
    }
    setIsGenerating(true);
    setGenerationError("");
    setGenerated(false);
    const start = startDate ? parseDateInput(startDate) : undefined;
    const end = Math.min(endDate ? parseDateInput(endDate, true) ?? Date.now() : Date.now(), Date.now());
    const dateQuery = {
      ...(start !== undefined ? { startAt: new Date(start).toISOString() } : {}),
      ...(end !== undefined ? { endAt: new Date(end).toISOString() } : {}),
    };
    const controller = new AbortController();
    exportController.current = controller;
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const [completeMovements, completeAlerts, completeAuditEvents] = await Promise.all([
        activeSource === "movements"
          ? readExport<{ items: MovementEvent[] }>("movements", {
              sortKey: "createdAt",
              sortDirection: "desc",
              ...(movementCheckpoint !== "all" ? { checkpoint: movementCheckpoint } : {}),
              ...(movementSubjectGroup !== "all" ? { subjectGroup: movementSubjectGroup } : {}),
              ...(movementResult !== "all" ? { result: movementResult } : {}),
              ...(movementDirection !== "all" ? { direction: movementDirection } : {}),
              ...(movementScanType !== "all" ? { scanType: movementScanType } : {}),
              ...(movementDenialCategory !== "all" ? { denialCategory: movementDenialCategory } : {}),
              ...dateQuery,
            }, controller.signal).then(result => result.items)
          : Promise.resolve(reportMovements),
        activeSource === "alerts"
          ? readExport<{ items: Alert[] }>("alerts", {
              ...(alertStatus !== "all" ? { status: alertStatus } : {}),
              ...dateQuery,
            }, controller.signal).then(result => result.items)
          : Promise.resolve(reportAlerts),
        activeSource === "permissions"
          ? readExport<{ items: AuditEvent[] }>("permissions", {
              ...dateQuery,
            }, controller.signal).then(result => result.items)
          : Promise.resolve(reportAuditEvents),
      ]);
      setReportMovements(completeMovements);
      setReportAlerts(completeAlerts);
      setReportAuditEvents(completeAuditEvents);
      setGenerated(true);
    } catch (error) {
      controller.abort();
      setGenerationError(error instanceof Error ? error.message : "Unable to load all report records.");
    } finally {
      clearTimeout(timer);
      setIsGenerating(false);
    }
  }

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    if (isGenerating) return;
    setter(value);
    setGenerationError("");
    setGenerated(false);
  }

  function openReportBuilder() {
    setGenerated(false);
    setGenerationError("");
    setDateRangeValid(true);
    setOpen(true);
  }

  function changeRange(start: string, end: string) {
    if (isGenerating) return;
    setStartDate(start);
    setEndDate(end);
    setDateRangeValid(true);
    setGenerated(false);
    setGenerationError("");
  }

  function chooseQuickRange(days?: number) {
    setRangePresetRevision((revision) => revision + 1);
    if (days === undefined) { changeRange("", ""); return; }
    const end = facilityToday();
    const start = new Date(`${end}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days + 1);
    changeRange(start.toISOString().slice(0, 10), end);
  }

  function formatDate(value: string) {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${value}T12:00:00Z`));
  }

  const rangeLabel = startDate && endDate ? `${formatDate(startDate)} – ${formatDate(endDate)}`
    : startDate ? `From ${formatDate(startDate)}` : endDate ? `Through ${formatDate(endDate)}` : "All history";

  function downloadCsv() {
    const header = ["Source", "Date", "Time", "Subject", "Outcome", "Details", "Reference"];
    const content = [
      header.map(escapeCsv).join(","),
      ...rows.map((row) =>
        [row.source, row.date, row.time, row.subject, row.outcome, row.details, row.reference]
          .map(escapeCsv)
          .join(",")
      ),
    ].join("\n");
    try { assertCsvBound(content); }
    catch (error) { setGenerationError(error instanceof Error ? error.message : "The CSV is too large."); return; }
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `in-out-audit-report-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={styles.trigger}
        type="button"
        aria-label="Generate audit report"
        title="Generate audit report"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openReportBuilder}
      >
        <FileBarChart size={18} aria-hidden="true" />
        <span>Generate report</span>
      </button>
      {open ? (
          <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId}
            onCancel={(event) => { event.preventDefault(); if (!isGenerating) setOpen(false); }}
            onClick={(event) => {
              if (event.target !== event.currentTarget || isGenerating) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false);
            }}>
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!generated) void generateReport(); }}>
            <header className={styles.header}>
              <span className={styles.headerIcon}><FileBarChart size={24} aria-hidden="true" /></span>
              <div className={styles.headerCopy}>
                <h2 id={titleId}>Generate report</h2>
                <p>{SOURCE_LABELS[activeSource]} <span aria-hidden="true">·</span> CSV export</p>
              </div>
              <button className={styles.close} type="button" aria-label="Close report builder" disabled={isGenerating} onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </header>

            <div className={`${styles.body} scrollable-content`} aria-busy={isGenerating}>
            <section className={styles.dateSection} aria-label="Report dates">
              <div className={styles.sectionHeading}><h3><CalendarDays size={17} aria-hidden="true" />Date range</h3><span>{dateRangeValid ? rangeLabel : "Check your dates"}</span></div>
              <fieldset className={styles.dateFields} disabled={isGenerating}>
                <div className={styles.quickRanges} role="group" aria-label="Quick date ranges">
                  {([{ label: "All time", days: undefined }, { label: "Today", days: 1 }, { label: "Last 7 days", days: 7 }, { label: "Last 30 days", days: 30 }] as const).map(({ label, days }) => {
                    const today = facilityToday();
                    const from = new Date(`${today}T12:00:00Z`);
                    from.setUTCDate(from.getUTCDate() - (days ?? 1) + 1);
                    const selected = dateRangeValid && (days === undefined ? !startDate && !endDate : startDate === from.toISOString().slice(0, 10) && endDate === today);
                    return <button type="button" key={label} aria-pressed={selected} onClick={() => chooseQuickRange(days)}>{label}</button>;
                  })}
                </div>
                <CalendarDatePicker key={rangePresetRevision} className={styles.datePicker} variant="inline" applyOnChange
                  startDate={startDate} endDate={endDate} onRangeChange={changeRange}
                  onValidityChange={(valid) => { setDateRangeValid(valid); setGenerated(false); setGenerationError(""); }} />
              </fieldset>
            </section>

            {activeSource === "movements" ? (
              <section className={styles.filterSection} aria-label="Movement filters">
                <h3>Movement filters</h3>
                <div className={styles.filterGrid}>
                  <label className={styles.filterField}>
                    <span>Checkpoint</span>
                    <select value={movementCheckpoint} disabled={isGenerating} onChange={(event) => updateFilter(setMovementCheckpoint, event.target.value)}>
                      <option value="all">All checkpoints</option>
                      {checkpoints.map((checkpoint) => {
                        const label = normalizeCheckpointLabel(checkpoint);
                        return label ? <option value={label} key={label}>{label}</option> : null;
                      })}
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Subject type</span>
                    <select value={movementSubjectGroup} disabled={isGenerating} onChange={(event) => updateFilter(setMovementSubjectGroup, event.target.value as typeof movementSubjectGroup)}>
                      <option value="all">All subjects</option><option value="people">People</option><option value="hardware">Hardware</option>
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Result</span>
                    <select value={movementResult} disabled={isGenerating} onChange={(event) => {
                      updateFilter(setMovementResult, event.target.value as typeof movementResult);
                      if (event.target.value === "approved") setMovementDenialCategory("all");
                    }}>
                      <option value="all">All results</option><option value="approved">Approved</option><option value="denied">Denied</option>
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Direction</span>
                    <select value={movementDirection} disabled={isGenerating} onChange={(event) => updateFilter(setMovementDirection, event.target.value as typeof movementDirection)}>
                      <option value="all">All directions</option><option value="entry">Entry</option><option value="exit">Exit</option>
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Scan type</span>
                    <select value={movementScanType} disabled={isGenerating} onChange={(event) => updateFilter(setMovementScanType, event.target.value as typeof movementScanType)}>
                      <option value="all">All scan types</option><option value="auto">Automatic</option><option value="manual">Manual</option>
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Denial reason</span>
                    <select value={movementDenialCategory} disabled={isGenerating || movementResult === "approved"} onChange={(event) => updateFilter(setMovementDenialCategory, event.target.value as typeof movementDenialCategory)}>
                      <option value="all">All denial reasons</option><option value="restricted">Restricted</option><option value="other">Other</option>
                    </select>
                  </label>
                </div>
              </section>
            ) : null}
            {activeSource === "alerts" ? (
              <section className={styles.filterSection} aria-label="Alert filters">
                <h3>Alert filters</h3>
                <div className={styles.filterGrid}>
                  <label className={styles.filterField}>
                    <span>Status</span>
                    <select value={alertStatus} disabled={isGenerating} onChange={(event) => updateFilter(setAlertStatus, event.target.value as typeof alertStatus)}>
                      <option value="all">All statuses</option><option value="active">Active</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="warned">Warned</option><option value="resolved">Resolved</option>
                    </select>
                  </label>
                  <label className={styles.filterField}>
                    <span>Severity</span>
                    <select value={alertSeverity} disabled={isGenerating} onChange={(event) => updateFilter(setAlertSeverity, event.target.value as typeof alertSeverity)}>
                      <option value="all">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option>
                    </select>
                  </label>
                </div>
              </section>
            ) : null}
            {activeSource === "permissions" ? (
              <section className={styles.filterSection} aria-label="Permission filters">
                <h3>Permission filters</h3>
                <div className={styles.filterGrid}>
                  <label className={styles.filterField}>
                    <span>Decision</span>
                    <select value={permissionDecision} disabled={isGenerating} onChange={(event) => updateFilter(setPermissionDecision, event.target.value as typeof permissionDecision)}>
                      <option value="all">All decisions</option><option value="granted">Granted</option><option value="denied">Denied</option>
                    </select>
                  </label>
                </div>
              </section>
            ) : null}

            {generationError ? <p className={styles.error} role="alert">{generationError}</p> : null}

            {generated ? (
              <div className={styles.ready} aria-live="polite">
                <span className={styles.readyIcon}><Check size={17} aria-hidden="true" /></span>
                <div className={styles.readyCopy}>
                  <strong>{rows.length ? "Report ready" : "No matching records"}</strong>
                  <span>{rows.length ? "Ready to download as CSV" : "Try a different date range or filter"}</span>
                </div>
                <span className={styles.readyCount}><strong>{rows.length.toLocaleString()}</strong><small>records</small></span>
              </div>
            ) : null}
            </div>

            <footer className={styles.footer}>
              <button className={styles.cancel} type="button" disabled={isGenerating} onClick={() => setOpen(false)}>
                {generated ? "Close" : "Cancel"}
              </button>
              {generated ? (
                <button className={styles.primary} type="button" onClick={downloadCsv} disabled={!rows.length}>
                  <Download size={17} />
                  Download CSV
                </button>
              ) : (
                <button
                  className={styles.primary}
                  type="submit"
                  aria-live="polite"
                  disabled={isGenerating || !dateRangeValid}
                >
                  {isGenerating ? <><LoaderCircle className={styles.spinner} size={17} />Loading records…</> : <><FileBarChart size={17} />Generate report</>}
                </button>
              )}
            </footer>
          </form>
          </dialog>
      ) : null}
    </>
  );
}
