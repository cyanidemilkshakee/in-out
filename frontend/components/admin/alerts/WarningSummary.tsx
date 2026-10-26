"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import type { Alert, AlertWarningSummary } from "../../../../lib/types";
import type { AlertSubjectOption } from "./AlertSubjectPicker";
import { formatAlertReviewDate } from "./alertPresentation";
import styles from "./EmployeeAlertManagement.module.css";

export function WarningSummary({ warnings, alerts, selectedSubject, onReset, onViewHistory, showHistoryAction = true, hideWarningEmptyText = false, isLoading = false, className = "" }: {
  warnings: AlertWarningSummary[];
  alerts: Alert[];
  selectedSubject?: AlertSubjectOption;
  onReset: (subjectId: string, reason: string) => Promise<void>;
  onViewHistory?: () => void;
  showHistoryAction?: boolean;
  hideWarningEmptyText?: boolean;
  isLoading?: boolean;
  className?: string;
}) {
  const profileSummary = className.includes("employee-profile-warning-summary");
  const [reason, setReason] = useState("");
  const [invalidReason, setInvalidReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const selected = selectedSubject
    ? warnings.find((subject) => subject.subjectType === selectedSubject.subjectType && subject.subjectId === selectedSubject.subjectId)
    : undefined;
  const warningCount = selected?.count ?? 0;
  const hasEntryRestriction = Boolean(selected?.entryRestriction?.active);
  const canReset = Boolean(selected && (warningCount > 0 || hasEntryRestriction));
  const resetTimestamp = selected?.resetAt ? new Date(selected.resetAt).getTime() : Number.NEGATIVE_INFINITY;
  const triggeredWarnings = selectedSubject ? alerts
    .filter((alert) => {
      const matchesSubject = alert.subjectId === selectedSubject.subjectId
        || (!alert.subjectId && alert.barcode.toLowerCase() === selectedSubject.barcode.toLowerCase());
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
  }, [selectedSubject?.subjectId]);

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

  return <section className={`${styles.warnings} ${className}`} aria-label="Confirmed warnings" aria-busy={busy}>
    {selectedSubject ? <>
      <div className={`${styles.warningOverview}${profileSummary ? " employee-profile-warning-overview" : ""}`}>
        <div className={`${styles.warningCount}${profileSummary ? " employee-profile-warning-count" : ""}`}><strong>{warningCount}</strong><span>Confirmed warning{warningCount === 1 ? "" : "s"}</span></div>
        {showHistoryAction ? (onViewHistory
          ? <button type="button" className={`${styles.button} ${styles.historyLink}`} onClick={onViewHistory}>View history<ArrowUpRight size={17} aria-hidden="true" /></button>
          : <Link className={styles.historyLink} href={`/admin/registry?tab=alerts&subject=${encodeURIComponent(selectedSubject.subjectId)}`}>View history<ArrowUpRight size={17} aria-hidden="true" /></Link>) : null}
        {hasEntryRestriction && <span className={`${styles.holdBadge}${profileSummary ? " employee-profile-warning-hold" : ""}`}><ShieldAlert size={17} aria-hidden="true" />Entry blocked</span>}
      </div>
      {triggeredWarnings.length ? <ul className={`${styles.warningList} scrollable-content${profileSummary ? " employee-profile-warning-list" : ""}`}>{triggeredWarnings.map((alert) => (
        <li key={alert.id}>
          <div><strong>{alert.title || alert.ruleId || "Confirmed alert"}</strong>{alert.severity !== "medium" && <span className={styles.severity} data-severity={alert.severity}>{alert.severity}</span>}</div>
          {alert.review?.reviewedAt && <time dateTime={alert.review.reviewedAt}>{formatAlertReviewDate(alert.review.reviewedAt)}</time>}
        </li>
      ))}</ul> : hideWarningEmptyText ? null : <p className={styles.warningEmpty}>{warningCount ? "Warning details are available in alert history." : "No current warnings."}</p>}
      {canReset && <div className={`${styles.resetPanel}${profileSummary ? " employee-profile-warning-reset" : ""}`}>
        <div className={`${styles.resetControls}${profileSummary ? " employee-profile-warning-reset-controls" : ""}`}>
          <input ref={noteRef} type="text" maxLength={1000} value={reason} disabled={busy || isLoading} aria-label={`Reason to reset warnings for ${selectedSubject.subjectName}`} aria-invalid={invalidReason} placeholder="Reason for reset (required)" onChange={(event) => { setReason(event.target.value); if (event.target.value.trim()) setInvalidReason(false); }} />
          <button type="button" className={`${styles.button} ${styles.resetButton}${profileSummary ? " employee-profile-warning-reset-button" : ""}`} disabled={busy || isLoading} onClick={() => void reset()}>
            {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <RotateCcw size={17} aria-hidden="true" />}
            {busy ? "Resetting…" : "Reset warnings"}
          </button>
        </div>
      </div>}
      {selected?.resetAt && <p className={styles.lastReset}>Last reset {formatAlertReviewDate(selected.resetAt)}</p>}
      {error && <p className={styles.error} role="status">{error}</p>}
    </> : <p className={styles.empty}>{isLoading ? "Loading warning counts…" : "Select a person above to view confirmed warnings."}</p>}
  </section>;
}
