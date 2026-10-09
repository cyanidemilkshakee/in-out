"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import type { Alert, AlertWarningSummary } from "../../../../lib/types";
import type { AlertSubjectOption } from "./AlertSubjectPicker";
import { formatAlertReviewDate } from "./alertPresentation";
import styles from "./EmployeeAlertManagement.module.css";

export function WarningSummary({ warnings, alerts, selectedEmployee, onReset, isLoading = false }: {
  warnings: AlertWarningSummary[];
  alerts: Alert[];
  selectedEmployee?: AlertSubjectOption;
  onReset: (subjectId: string, reason: string) => Promise<void>;
  isLoading?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [invalidReason, setInvalidReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const selected = selectedEmployee
    ? warnings.find((subject) => subject.subjectType === "employee" && subject.subjectId === selectedEmployee.subjectId)
    : undefined;
  const warningCount = selected?.count ?? 0;
  const hasEntryRestriction = Boolean(selected?.entryRestriction?.active);
  const canReset = Boolean(selected && (warningCount > 0 || hasEntryRestriction));
  const resetTimestamp = selected?.resetAt ? new Date(selected.resetAt).getTime() : Number.NEGATIVE_INFINITY;
  const triggeredWarnings = selectedEmployee ? alerts
    .filter((alert) => {
      const matchesSubject = alert.subjectId === selectedEmployee.subjectId
        || (!alert.subjectId && alert.barcode.toLowerCase() === selectedEmployee.barcode.toLowerCase());
      const reviewedAt = alert.review?.reviewedAt ? new Date(alert.review.reviewedAt).getTime() : 0;
      return matchesSubject
        && alert.review?.decision === "confirmed"
        && reviewedAt > resetTimestamp;
    })
    .sort((left, right) => new Date(right.review?.reviewedAt ?? 0).getTime() - new Date(left.review?.reviewedAt ?? 0).getTime())
    : [];

  useEffect(() => {
    setReason("");
    setInvalidReason(false);
    setError("");
  }, [selectedEmployee?.subjectId]);

  async function reset() {
    if (!selected || !canReset || pending.current) return;
    const note = reason.trim();
    if (!note) { setInvalidReason(true); noteRef.current?.focus(); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    try { await onReset(selected.subjectId, note); setReason(""); setInvalidReason(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to reset warnings."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section className={styles.warnings} aria-label="Confirmed warnings" aria-busy={busy}>
    {selectedEmployee ? <>
      <div className={styles.warningOverview}>
        <div className={styles.warningCount}><strong>{warningCount}</strong><span>Confirmed warning{warningCount === 1 ? "" : "s"}</span></div>
        <Link className={styles.historyLink} href={`/admin/registry?tab=alerts&subject=${encodeURIComponent(selectedEmployee.subjectId)}`}>View history<ArrowUpRight size={17} aria-hidden="true" /></Link>
        {hasEntryRestriction && <span className={styles.holdBadge}><ShieldAlert size={17} aria-hidden="true" />Entry blocked</span>}
      </div>
      {triggeredWarnings.length ? <ul className={styles.warningList}>{triggeredWarnings.map((alert) => (
        <li key={alert.id}>
          <div><strong>{alert.title || alert.ruleId || "Confirmed alert"}</strong><span className={styles.severity} data-severity={alert.severity}>{alert.severity}</span></div>
          {alert.review?.reviewedAt && <time dateTime={alert.review.reviewedAt}>{formatAlertReviewDate(alert.review.reviewedAt)}</time>}
        </li>
      ))}</ul> : <p className={styles.warningEmpty}>{warningCount ? "Warning details are available in alert history." : "No current warnings."}</p>}
      {canReset && <div className={styles.resetPanel}>
        <div className={styles.resetControls}>
          <input ref={noteRef} type="text" maxLength={1000} value={reason} disabled={busy || isLoading} aria-label={`Reason to reset warnings for ${selectedEmployee.subjectName}`} aria-invalid={invalidReason} placeholder="Reason for reset (required)" onChange={(event) => { setReason(event.target.value); if (event.target.value.trim()) setInvalidReason(false); }} />
          <button type="button" className={`${styles.button} ${styles.resetButton}`} disabled={busy || isLoading} onClick={() => void reset()}>
            {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <RotateCcw size={17} aria-hidden="true" />}
            {busy ? "Resetting…" : "Reset warnings"}
          </button>
        </div>
      </div>}
      {selected?.resetAt && <p className={styles.lastReset}>Last reset {formatAlertReviewDate(selected.resetAt)}</p>}
      {error && <p className={styles.error} role="status">{error}</p>}
    </> : <p className={styles.empty}>{isLoading ? "Loading warning counts…" : "Select an employee above to view confirmed warnings."}</p>}
  </section>;
}
