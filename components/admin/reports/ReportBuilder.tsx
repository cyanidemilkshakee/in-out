"use client";

import { useMemo, useState } from "react";
import { Download, FileBarChart, X } from "lucide-react";
import type { Alert, AuditEvent, MovementEvent } from "../../../lib/types";
import { CalendarDatePicker } from "../../analytics/CalendarDatePicker";

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

function escapeCsv(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseReportDate(date: string, time: string, createdAt?: string) {
  const parsed = createdAt ? new Date(createdAt).getTime() : new Date(`${date} ${time}`).getTime();
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
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ReportSource[]>([
    "movements",
    "alerts",
    "permissions",
  ]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generated, setGenerated] = useState(false);

  const rows = useMemo(() => {
    const start = startDate ? new Date(startDate).getTime() : Number.NEGATIVE_INFINITY;
    const end = endDate ? new Date(endDate).getTime() : Number.POSITIVE_INFINITY;
    const reportRows: Array<ReportRow & { timestamp: number }> = [];

    if (sources.includes("movements")) {
      for (const movement of movements) {
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
      for (const alert of alerts) {
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
      for (const audit of auditEvents) {
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
      .filter((row) => row.timestamp >= start && row.timestamp <= end)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(({ timestamp: _timestamp, ...row }) => row);
  }, [alerts, auditEvents, endDate, movements, sources, startDate]);

  function toggleSource(source: ReportSource) {
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
      <button className="report-trigger" type="button" onClick={() => setOpen(true)}>
        <FileBarChart size={17} />
        Generate report
      </button>
      {open ? (
        <div className="report-dialog-backdrop" role="presentation">
          <section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <header>
              <div>
                <h2 id="report-title">Generate audit report</h2>
                <p>Combine movement, alert, and manual permission evidence into one export.</p>
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
                  setStartDate(start);
                  setEndDate(end);
                  setGenerated(false);
                }}
              />
            </div>

            {generated ? (
              <div className="report-preview" aria-live="polite">
                <span>Report ready</span>
                <strong>{rows.length.toLocaleString()} records</strong>
                <small>
                  {sources.length} source{sources.length === 1 ? "" : "s"} selected
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
                  onClick={() => setGenerated(true)}
                  disabled={!sources.length}
                >
                  Generate report
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
