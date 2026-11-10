"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, X } from "lucide-react";
import type { Alert, Person } from "../../../../lib/types";
import { normalizeCheckpointLabel } from "../../../../lib/normalizeDashboard";
import { PersonStatusLabel } from "../PersonStatusLabel";
import { alertGroupDateRange, alertTimestamp, formatAlertExplanation, formatAlertReviewDate, getAlertReviewState, groupAlertsBySubjectAndType, type AlertReviewFilter } from "./alertPresentation";
import styles from "./AlertActivity.module.css";

type ReviewDecision = "confirmed" | "excused";
type ReviewHandler = (alertId: string, decision: ReviewDecision, reason?: string) => Promise<Alert>;
type AcknowledgeHandler = (alertId: string) => Promise<Alert>;

function AlertReviewCard({ alert, employeeStatus, onReview, onAcknowledge, hasEarlierUnreviewedAlert, disabled, showSubjectDetails, showDescription }: {
  alert: Alert;
  employeeStatus?: Person["status"];
  onReview: ReviewHandler;
  onAcknowledge?: AcknowledgeHandler;
  hasEarlierUnreviewedAlert: boolean;
  disabled: boolean;
  showSubjectDetails: boolean;
  showDescription: boolean;
}) {
  const [reason, setReason] = useState("");
  const [invalidReason, setInvalidReason] = useState(false);
  const [busy, setBusy] = useState<ReviewDecision | "acknowledged" | null>(null);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const checkpointLabel = normalizeCheckpointLabel(alert.checkpoint);
  const reviewState = getAlertReviewState(alert);
  const confirmedWarningNumber = reviewState === "confirmed" ? alert.warningNumber : undefined;
  const warningLimitReached = (alert.warningCount ?? 0) >= 3;
  const checkpointScanBurst = alert.ruleId === "rule-scan-burst" && !alert.subjectId;

  async function review(decision: ReviewDecision) {
    if (disabled || pending.current || hasEarlierUnreviewedAlert || warningLimitReached) return;
    const note = reason.trim();
    if (decision === "excused" && !note) { setInvalidReason(true); noteRef.current?.focus(); return; }
    pending.current = true;
    setBusy(decision);
    setError("");
    try { await onReview(alert.id, decision, note || undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save this alert review."); }
    finally { pending.current = false; setBusy(null); }
  }

  async function acknowledge() {
    if (disabled || pending.current || busy !== null || !onAcknowledge) return;
    pending.current = true;
    setBusy("acknowledged");
    setError("");
    try { await onAcknowledge(alert.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to acknowledge this alert."); }
    finally { pending.current = false; setBusy(null); }
  }

  return <article className="admin-surface">
    <time><strong>{alert.time}</strong><small>{alert.date}</small></time>
    <span className="alert-activity-dot" data-severity={alert.severity} aria-hidden="true" />
    <div className="alert-activity-copy">
      <div className="alert-activity-title-row">
        <strong>{alert.title}</strong>
        {alert.severity !== "medium" && <span className={`severity severity-${alert.severity}`}>{alert.severity}</span>}
        {reviewState !== "needs_review" && <span className="alert-review-state admin-surface" data-state={reviewState}>{reviewState === "confirmed" ? "Accepted" : reviewState === "acknowledged" ? "Acknowledged" : "Excused"}</span>}
      </div>
      {showSubjectDetails && !checkpointScanBurst && <div className="alert-activity-subject-row">
        <strong className="alert-activity-warning-subject">{alert.subjectName}</strong>
        <PersonStatusLabel status={employeeStatus} />
        <small className="alert-activity-barcode">{alert.barcode}</small>
      </div>}
      {checkpointLabel && checkpointLabel.trim().toLowerCase() !== "attendance policy" && <small>{checkpointLabel}</small>}
      {showDescription && <p className="alert-activity-description">{formatAlertExplanation(alert)}</p>}
      {alert.review && <small className="alert-review-record">{alert.review.decision === "confirmed" ? "Accepted" : "Excused"}{alert.review.reviewedAt ? ` ${formatAlertReviewDate(alert.review.reviewedAt)}` : ""}{alert.review.reviewedBy ? ` · ${alert.review.reviewedBy}` : ""}</small>}
      {alert.review?.reason && <p className="alert-review-note"><strong>Review note:</strong> {alert.review.reason}</p>}
      {alert.warningResetAt && <small>Warnings reset {formatAlertReviewDate(alert.warningResetAt)}{alert.warningResetBy ? ` · ${alert.warningResetBy}` : ""}. This review remains in history.</small>}
      {alert.warningResetReason && <p className="alert-review-note"><strong>Reset note:</strong> {alert.warningResetReason}</p>}
    </div>
    {!checkpointScanBurst && confirmedWarningNumber !== undefined && <div className="alert-activity-marker"><span className="alert-warning-label admin-surface" data-severity={alert.severity} aria-label={`Warning ${confirmedWarningNumber}`}>Warning {confirmedWarningNumber}</span></div>}
    {reviewState === "needs_review" && checkpointScanBurst && <div className="alert-review-controls">
      <button type="button" className="alert-accept-button" disabled={disabled || busy !== null || !onAcknowledge} onClick={() => void acknowledge()}><Check size={15} aria-hidden="true" />{busy === "acknowledged" ? "Acknowledging…" : "Acknowledge"}</button>
      {error && <p className="alert-action-error" role="status">{error}</p>}
    </div>}
    {reviewState === "needs_review" && !checkpointScanBurst && <div className="alert-review-controls">
      <input className="admin-surface" ref={noteRef} type="text" maxLength={1000} value={reason} disabled={disabled || busy !== null} aria-label={`Review note for ${alert.subjectName}`} aria-invalid={invalidReason} placeholder="Add a note (required to excuse)." onChange={(event) => { setReason(event.target.value); if (event.target.value.trim()) setInvalidReason(false); }} />
      <div className="alert-activity-actions">
        <button type="button" className="alert-accept-button" disabled={disabled || busy !== null || hasEarlierUnreviewedAlert || warningLimitReached} onClick={() => void review("confirmed")}><Check size={15} aria-hidden="true" />{busy === "confirmed" ? "Accepting…" : "Accept"}</button>
        <button type="button" className="alert-excuse-button" disabled={disabled || busy !== null || hasEarlierUnreviewedAlert || warningLimitReached} onClick={() => void review("excused")}><X size={15} aria-hidden="true" />{busy === "excused" ? "Excusing…" : "Excuse"}</button>
      </div>
      {hasEarlierUnreviewedAlert && <p className="alert-action-error" role="status">Review the earlier alert for this person first.</p>}
      {!hasEarlierUnreviewedAlert && warningLimitReached && <p className="alert-action-error" role="status">Reset confirmed warnings before reviewing another alert.</p>}
      {error && <p className="alert-action-error" role="status">{error}</p>}
    </div>}
  </article>;
}

export function AlertActivity({ alerts, people, onReview, onAcknowledge, filter, isLoading = false, disabled = false, emptyMessage, className = "", totalCount, pagination, showSubjectDetails = true, showDescription = true }: {
  alerts: Alert[];
  people: Person[];
  onReview: ReviewHandler;
  onAcknowledge?: AcknowledgeHandler;
  filter: AlertReviewFilter;
  isLoading?: boolean;
  disabled?: boolean;
  emptyMessage?: string;
  className?: string;
  totalCount?: number;
  pagination?: ReactNode;
  showSubjectDetails?: boolean;
  showDescription?: boolean;
}) {
  const titleId = useId();
  const sortedAlerts = useMemo(() => [...alerts].sort((a, b) => {
    const ageOrder = alertTimestamp(a) - alertTimestamp(b);
    if (ageOrder !== 0) return filter === "needs_review" ? ageOrder : -ageOrder;
    return a.id.localeCompare(b.id);
  }), [alerts, filter]);
  const alertGroups = useMemo(() => groupAlertsBySubjectAndType(sortedAlerts), [sortedAlerts]);
  const employeeStatuses = useMemo(
    () => new Map(people.filter((person) => person.type === "employee").map((person) => [person.id, person.status] as const)),
    [people]
  );
  const employeeStatusesByBarcode = useMemo(
    () => new Map(people.filter((person) => person.type === "employee").map((person) => [person.barcode, person.status] as const)),
    [people]
  );
  const title = filter === "needs_review" ? "Open alerts" : filter === "confirmed" ? "Accepted alerts" : filter === "excused" ? "Excused mistakes" : "Alert history";
  function renderAlert(alert: Alert) {
    const hasEarlierUnreviewedAlert = sortedAlerts.some((candidate) => {
      if (candidate.id === alert.id || getAlertReviewState(candidate) !== "needs_review") return false;
      const sameSubject = candidate.subjectId && alert.subjectId
        ? candidate.subjectId === alert.subjectId
        : candidate.barcode.toLowerCase() === alert.barcode.toLowerCase();
      const candidateTime = alertTimestamp(candidate);
      const alertTime = alertTimestamp(alert);
      return sameSubject && (candidateTime < alertTime || (candidateTime === alertTime && candidate.id < alert.id));
    });
    return <AlertReviewCard key={alert.id} alert={alert} employeeStatus={(alert.subjectId ? employeeStatuses.get(alert.subjectId) : undefined) ?? employeeStatusesByBarcode.get(alert.barcode)} onReview={onReview} onAcknowledge={onAcknowledge} hasEarlierUnreviewedAlert={hasEarlierUnreviewedAlert} disabled={disabled || isLoading} showSubjectDetails={showSubjectDetails} showDescription={showDescription} />;
  }
  return <section className={`alert-activity-section admin-surface${filter === "needs_review" ? " alert-activity-section--open" : ""} ${className}`} aria-labelledby={titleId} aria-busy={isLoading}>
    <div className="permission-section-heading"><div><h2 id={titleId}>{title}</h2></div><span>{totalCount ?? sortedAlerts.length} {filter === "needs_review" ? "open" : "records"}</span></div>
    <div className="alert-activity-list scrollable-content">
      {alertGroups.length ? alertGroups.map((group) => {
        if (group.alerts.length === 1) return renderAlert(group.alerts[0]);
        const first = group.alerts[0];
        const pendingCount = group.alerts.filter((alert) => getAlertReviewState(alert) === "needs_review").length;
        const acceptedCount = group.alerts.filter((alert) => getAlertReviewState(alert) === "confirmed").length;
        return <details className={styles.group} key={group.key}>
          <summary className={styles.groupSummary}>
            <span className={styles.groupCopy}>
              <strong>{first.title}</strong>
              <span>{first.subjectName || first.checkpoint}</span>
              <small>{alertGroupDateRange(group.alerts)}</small>
            </span>
            <span className={styles.groupCounts}>
              <strong>{group.alerts.length} occurrences</strong>
              <small>{pendingCount} open · {acceptedCount} accepted</small>
            </span>
            <ChevronDown className={styles.chevron} size={18} aria-hidden="true" />
          </summary>
          <div className={styles.occurrences}>{group.alerts.map(renderAlert)}</div>
        </details>;
      }) : <div className="alert-activity-empty"><AlertTriangle size={22} aria-hidden="true" /><strong>{isLoading ? "Loading alerts…" : emptyMessage ?? `No ${filter === "needs_review" ? "open alerts" : "alert records"} match these filters.`}</strong>{!isLoading && !emptyMessage && <span>Try another review status, time range, or search.</span>}</div>}
    </div>
    {pagination}
  </section>;
}
