"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileBarChart, X } from "lucide-react";
import type { Alert, AuditEvent, MovementEvent } from "../../../../lib/types";
import { CalendarDatePicker } from "../../analytics/CalendarDatePicker";
import { parseDateInput } from "../../../../lib/dateRanges";
import { escapeCsv } from "../../../../lib/csv";
import { useDataActions } from "../../../context/DataContext";

const REPORT_PAGE_SIZE = 200;

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

const SOURCE_OPTIONS: Array<{ id: ReportSource; label: string; description: string }> = [
  { id: "movements", label: "Movements", description: "Entries, exits, approvals, and denials" },
  { id: "alerts", label: "Alerts raised", description: "Rule and operator-created security alerts" },
  { id: "permissions", label: "Manual permissions", description: "Permissions granted or denied by administrators" },
];

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
}: {
  movements: MovementEvent[];
  alerts: Alert[];
  auditEvents: AuditEvent[];
}) {
  const { queryMovements, queryAlerts, queryAuditEvents } = useDataActions();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ReportSource[]>([
    "movements",
    "alerts",
    "permissions",
  ]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generated, setGenerated] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [reportMovements, setReportMovements] = useState(movements);
  const [reportAlerts, setReportAlerts] = useState(alerts);
  const [reportAuditEvents, setReportAuditEvents] = useState(auditEvents);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const rows = useMemo(() => {
    const start = startDate ? parseDateInput(startDate) ?? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const end = endDate ? Math.min(parseDateInput(endDate, true) ?? Number.NEGATIVE_INFINITY, Date.now()) : Date.now();
    const reportRows: Array<ReportRow & { timestamp: number }> = [];

    if (sources.includes("movements")) {
      for (const movement of reportMovements) {
        reportRows.push({
          source: "Movement",
          date: movement.date,
          time: movement.time,
          subject: movement.subjectName,
          outcome: movement.result,
          details: `${movement.direction} / ${movement.checkpoint}${movement.reason && movement.reason !== "-" ? ` / ${movement.reason}` : ""}`,
          reference: movement.id,
          timestamp: parseReportDate(movement.date, movement.time, movement.createdAt),
        });
      }
    }

    if (sources.includes("alerts")) {
      for (const alert of reportAlerts) {
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

    if (sources.includes("permissions")) {
      for (const audit of reportAuditEvents) {
        if (audit.category !== "permission" || !audit.decision) continue;
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
  }, [endDate, reportAlerts, reportAuditEvents, reportMovements, sources, startDate]);

  async function generateReport() {
    if (isGenerating || !sources.length) return;
    setIsGenerating(true);
    setGenerationError("");
    setGenerated(false);
    const start = startDate ? parseDateInput(startDate) : undefined;
    const end = Math.min(endDate ? parseDateInput(endDate, true) ?? Date.now() : Date.now(), Date.now());
    const dateQuery = {
      ...(start !== undefined ? { startAt: new Date(start).toISOString() } : {}),
      ...(end !== undefined ? { endAt: new Date(end).toISOString() } : {}),
    };

    async function loadAllPages<T>(
      fetchPage: (page: number) => Promise<{ items: T[]; total: number; pageSize?: number }>
    ) {
      const first = await fetchPage(1);
      const items = [...first.items];
      const pageSize = first.pageSize || REPORT_PAGE_SIZE;
      const pageCount = Math.ceil(first.total / pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        const next = await fetchPage(page);
        if (!next.items.length) break;
        items.push(...next.items);
      }
      return items;
    }

    try {
      const [completeMovements, completeAlerts, completeAuditEvents] = await Promise.all([
        sources.includes("movements")
          ? loadAllPages((page) => queryMovements({ page, pageSize: REPORT_PAGE_SIZE, includeChart: false, sortKey: "createdAt", sortDirection: "desc", ...dateQuery }))
          : Promise.resolve(reportMovements),
        sources.includes("alerts")
          ? loadAllPages((page) => queryAlerts({
              limit: REPORT_PAGE_SIZE,
              offset: (page - 1) * REPORT_PAGE_SIZE,
              ...dateQuery,
            }))
          : Promise.resolve(reportAlerts),
        sources.includes("permissions")
          ? loadAllPages((page) => queryAuditEvents({
              limit: REPORT_PAGE_SIZE,
              offset: (page - 1) * REPORT_PAGE_SIZE,
              category: "permission",
              ...dateQuery,
            }))
          : Promise.resolve(reportAuditEvents),
      ]);
      setReportMovements(completeMovements);
      setReportAlerts(completeAlerts);
      setReportAuditEvents(completeAuditEvents);
      setGenerated(true);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Unable to load all report records.");
    } finally {
      setIsGenerating(false);
    }
  }

  function toggleSource(source: ReportSource) {
    if (isGenerating) return;
    setGenerationError("");
    setGenerated(false);
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source]
    );
  }

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
        className="report-trigger"
        type="button"
        aria-label="Generate report"
        title="Generate report"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <FileBarChart size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="report-dialog-backdrop" role="presentation">
          <section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title" aria-describedby="report-description">
            <header>
              <div>
                <h2 id="report-title">Generate audit report</h2>
                <p id="report-description">Choose the evidence sources and facility dates to create a CSV audit trail.</p>
              </div>
              <button type="button" aria-label="Close report builder" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </header>

            <div className="report-source-list">
              {SOURCE_OPTIONS.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={sources.includes(option.id)}
                    onChange={() => toggleSource(option.id)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>

            <div className="report-date-row">
              <span>
                <strong>Date range</strong>
                <small>UTC+05:30 / Jan 1, 2016 to now</small>
              </span>
              <CalendarDatePicker
                startDate={startDate}
                endDate={endDate}
                onRangeChange={(start, end) => {
                  if (isGenerating) return;
                  setStartDate(start);
                  setEndDate(end);
                  setGenerated(false);
                  setGenerationError("");
                }}
              />
            </div>

            {generationError ? <p className="report-error" role="alert">{generationError}</p> : null}

            {generated ? (
              <div className="report-preview" aria-live="polite">
                <span>Report preview</span>
                <strong>{rows.length.toLocaleString()} records</strong>
                <small>
                  {sources.length} source{sources.length === 1 ? "" : "s"} selected · Facility time UTC+05:30
                </small>
              </div>
            ) : null}

            <footer>
              <button className="report-secondary" type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              {generated ? (
                <button className="report-primary" type="button" onClick={downloadCsv} disabled={!rows.length}>
                  <Download size={17} />
                  Download CSV
                </button>
              ) : (
                <button
                  className="report-primary"
                  type="button"
                  onClick={() => void generateReport()}
                  disabled={!sources.length || isGenerating}
                >
                  {isGenerating ? "Loading all records…" : "Generate report"}
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
