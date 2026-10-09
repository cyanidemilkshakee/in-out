"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useDataActions } from "../../../context/DataContext";
import type { AlertPage, Person } from "../../../../lib/types";
import { formatAlertReviewDate, getAlertReviewState, getAlertWarningLevel } from "./alertPresentation";
import { EmployeeStatusLabel } from "../EmployeeStatusLabel";
import styles from "./AlertsHistoryTable.module.css";

const PAGE_SIZE = 50;
const emptyPage: AlertPage = { items: [], total: 0, limit: PAGE_SIZE, offset: 0 };

export function AlertsHistoryTable({ search, subjectId, people, onLoad }: {
  search: string;
  subjectId?: string;
  people: Person[];
  onLoad: (page: AlertPage) => void;
}) {
  const { queryAlerts } = useDataActions();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AlertPage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const needle = search.trim().slice(0, 200);
  const subjectStatuses = new Map(people.map((person) => [person.id, person.status] as const));
  const subjectStatusesByBarcode = new Map(people.map((person) => [person.barcode, person.status] as const));

  useEffect(() => { setOffset(0); }, [needle, subjectId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    onLoad(emptyPage);
    void queryAlerts({ limit: PAGE_SIZE, offset, search: needle || undefined, subjectId }).then(result => {
      if (!active) return;
      if (offset > 0 && offset >= result.total) {
        setOffset(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1) * PAGE_SIZE);
        return;
      }
      setPage(result);
      onLoad(result);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load alert history.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [needle, offset, onLoad, queryAlerts, revision, subjectId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision(value => value + 1), 250);
    };
    const onMessage = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        if (update.alerts || update.type === "data_changed") refresh();
      } catch { /* Ignore malformed stream messages. */ }
    };
    window.addEventListener("inout:presence-message", onMessage);
    window.addEventListener("inout:alerts-changed", refresh);
    window.addEventListener("inout:presence-sync", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("inout:presence-message", onMessage);
      window.removeEventListener("inout:alerts-changed", refresh);
      window.removeEventListener("inout:presence-sync", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return <div aria-busy={loading}>
    {subjectId && <p className={styles.scope}>History for {page.items[0]?.subjectName || "the selected subject"}. <Link href="/admin/logs?tab=alerts">Show all subjects</Link></p>}
    {error && <p role="alert" className={styles.error}>{error} <button className="admin-button admin-button--ghost" type="button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    <div className="admin-table-wrap table-wrap">
      <table className={`data-table ${styles.table}`}>
        <caption className="sr-only">Alert history, final reviews, and warning resets</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Time</th><th scope="col">Alert</th><th scope="col">Subject</th><th scope="col">Type</th><th scope="col">Barcode</th><th scope="col">Status</th><th scope="col">Warning</th><th scope="col">Review</th><th scope="col">Warning reset</th></tr></thead>
        <tbody>{loading ? <tr><td colSpan={10} role="status">Loading alert history…</td></tr> : error ? <tr><td colSpan={10}>Alert history is unavailable.</td></tr> : page.items.length ? page.items.map(alert => {
          const state = getAlertReviewState(alert);
          const reviewLabel = state === "confirmed" ? "Accepted" : state === "excused" ? "Excused" : "Open";
          const warningLevel = getAlertWarningLevel(alert.severity);
          const subjectStatus = (alert.subjectId ? subjectStatuses.get(alert.subjectId) : undefined) ?? subjectStatusesByBarcode.get(alert.barcode);
          return <tr key={alert.id}>
            <td>{alert.date}</td>
            <td><time dateTime={alert.createdAt || undefined}>{alert.time}</time></td>
            <td><strong>{alert.title}</strong></td>
            <td><strong>{alert.subjectName || "Unbound subject"}</strong></td>
            <td className={styles.subjectType}>{alert.subjectType || "—"}</td>
            <td>{alert.barcode || "—"}</td>
            <td>{subjectStatus ? <EmployeeStatusLabel status={subjectStatus} /> : "—"}</td>
            <td><span className="alert-warning-label" data-severity={alert.severity} aria-label={`Warning ${warningLevel}`}>{warningLevel}</span></td>
            <td className={styles.reviewCell}><span className={`alert-review-state ${styles.reviewState}`} data-state={state}>{reviewLabel}</span>{alert.review?.reason && <small className={styles.reviewReason}>{alert.review.reason}</small>}</td>
            <td>{alert.warningResetAt ? <><strong>{formatAlertReviewDate(alert.warningResetAt)}</strong><small>{alert.warningResetBy}</small><span>{alert.warningResetReason}</span></> : "—"}</td>
          </tr>;
        }) : <tr><td colSpan={10}>No alerts match this search.</td></tr>}</tbody>
      </table>
    </div>
    <div className={`pagination ${styles.pagination}`}>
      <span>{page.total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, page.total)} of ${page.total}` : "0 alerts"}</span>
      <button type="button" disabled={loading || !!error || offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>Previous</button>
      <button type="button" disabled={loading || !!error || offset + PAGE_SIZE >= page.total} onClick={() => setOffset(value => value + PAGE_SIZE)}>Next</button>
    </div>
  </div>;
}
