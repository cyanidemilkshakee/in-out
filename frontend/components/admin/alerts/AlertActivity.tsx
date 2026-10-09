"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import type { Alert, Person } from "../../../../lib/types";
import { EmployeeStatusLabel } from "../EmployeeStatusLabel";
import { alertTimestamp, formatAlertExplanation, formatAlertReviewDate, getAlertReviewState, getAlertWarningLevel, getOpenAlertWarningNumber, type AlertReviewFilter } from "./alertPresentation";

type ReviewDecision = "confirmed" | "excused";
type ReviewHandler = (alertId: string, decision: ReviewDecision, reason?: string) => Promise<Alert>;

function AlertReviewCard({ alert, employeeStatus, onReview }: { alert: Alert; employeeStatus?: Person["status"]; onReview: ReviewHandler }) {
  const [reason, setReason] = useState("");
  const [invalidReason, setInvalidReason] = useState(false);
  const [busy, setBusy] = useState<ReviewDecision | null>(null);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const reviewState = getAlertReviewState(alert);
  const warningLevel = reviewState === "needs_review" ? getOpenAlertWarningNumber(alert) : getAlertWarningLevel(alert.severity);

  async function review(decision: ReviewDecision) {
    if (pending.current) return;
    const note = reason.trim();
    if (decision === "excused" && !note) { setInvalidReason(true); noteRef.current?.focus(); return; }
    pending.current = true;
    setBusy(decision);
    setError("");
    try { await onReview(alert.id, decision, note || undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save this alert review."); }
    finally { pending.current = false; setBusy(null); }
  }

  return <article className="admin-surface">
    <time><strong>{alert.time}</strong><small>{alert.date}</small></time>
    <span className="alert-activity-dot" data-severity={alert.severity} aria-hidden="true" />
    <div className="alert-activity-copy">
      <div className="alert-activity-title-row">
        <strong>{alert.title}</strong>
        <span className={`severity severity-${alert.severity}`}>{alert.severity}</span>
        {reviewState !== "needs_review" && <span className="alert-review-state admin-surface" data-state={reviewState}>{reviewState === "confirmed" ? "Accepted" : "Excused"}</span>}
      </div>
      <div className="alert-activity-subject-row">
        <strong className="alert-activity-warning-subject">{alert.subjectName}</strong>
        <EmployeeStatusLabel status={employeeStatus} />
        <small className="alert-activity-barcode">{alert.barcode}</small>
      </div>
      {alert.checkpoint && alert.checkpoint.trim().toLowerCase() !== "attendance policy" && <small>{alert.checkpoint}</small>}
      <p className="alert-activity-description">{formatAlertExplanation(alert)}</p>
      {alert.review && <small className="alert-review-record">{alert.review.decision === "confirmed" ? "Accepted" : "Excused"}{alert.review.reviewedAt ? ` ${formatAlertReviewDate(alert.review.reviewedAt)}` : ""}{alert.review.reviewedBy ? ` · ${alert.review.reviewedBy}` : ""}</small>}
      {alert.review?.reason && <p className="alert-review-note"><strong>Review note:</strong> {alert.review.reason}</p>}
      {alert.warningResetAt && <small>Warnings reset {formatAlertReviewDate(alert.warningResetAt)}{alert.warningResetBy ? ` · ${alert.warningResetBy}` : ""}. This review remains in history.</small>}
      {alert.warningResetReason && <p className="alert-review-note"><strong>Reset note:</strong> {alert.warningResetReason}</p>}
    </div>
    <div className="alert-activity-marker"><span className="alert-warning-label admin-surface" data-severity={alert.severity} aria-label={`Warning ${warningLevel}, ${alert.severity} severity`}>Warning {warningLevel}</span></div>
    {reviewState === "needs_review" && <div className="alert-review-controls">
      <input className="admin-surface" ref={noteRef} type="text" maxLength={1000} value={reason} disabled={busy !== null} aria-label={`Review note for ${alert.subjectName}`} aria-invalid={invalidReason} placeholder="Add a note (required to excuse)." onChange={(event) => { setReason(event.target.value); if (event.target.value.trim()) setInvalidReason(false); }} />
      <div className="alert-activity-actions">
        <button type="button" className="alert-accept-button" disabled={busy !== null} onClick={() => void review("confirmed")}><Check size={15} aria-hidden="true" />{busy === "confirmed" ? "Accepting…" : "Accept"}</button>
        <button type="button" className="alert-excuse-button" disabled={busy !== null} onClick={() => void review("excused")}><X size={15} aria-hidden="true" />{busy === "excused" ? "Excusing…" : "Excuse"}</button>
      </div>
      {error && <p className="alert-action-error" role="status">{error}</p>}
    </div>}
  </article>;
}

export function AlertActivity({ alerts, people, onReview, filter, isLoading = false }: {
  alerts: Alert[];
  people: Person[];
  onReview: ReviewHandler;
  filter: AlertReviewFilter;
  isLoading?: boolean;
}) {
  const sortedAlerts = useMemo(() => [...alerts].sort((a, b) => {
    const ageOrder = alertTimestamp(a) - alertTimestamp(b);
    if (ageOrder !== 0) return filter === "needs_review" ? ageOrder : -ageOrder;
    return a.id.localeCompare(b.id);
  }), [alerts, filter]);
  const employeeStatuses = useMemo(
    () => new Map(people.filter((person) => person.type === "employee").map((person) => [person.id, person.status] as const)),
    [people]
  );
  const employeeStatusesByBarcode = useMemo(
    () => new Map(people.filter((person) => person.type === "employee").map((person) => [person.barcode, person.status] as const)),
    [people]
  );
  const title = filter === "needs_review" ? "Open alerts" : filter === "confirmed" ? "Accepted alerts" : filter === "excused" ? "Excused mistakes" : "Alert history";
  return <section className={`alert-activity-section admin-surface${filter === "needs_review" ? " alert-activity-section--open" : ""}`} aria-labelledby="alert-activity-title">
    <div className="permission-section-heading"><div><h2 id="alert-activity-title">{title}</h2></div><span>{sortedAlerts.length} {filter === "needs_review" ? "open" : "records"}</span></div>
    <div className="alert-activity-list">
      {sortedAlerts.length ? sortedAlerts.map((alert) => <AlertReviewCard key={alert.id} alert={alert} employeeStatus={(alert.subjectId ? employeeStatuses.get(alert.subjectId) : undefined) ?? employeeStatusesByBarcode.get(alert.barcode)} onReview={onReview} />) : <div className="alert-activity-empty"><AlertTriangle size={22} aria-hidden="true" /><strong>{isLoading ? "Loading alerts…" : `No ${filter === "needs_review" ? "open alerts" : "alert records"} match these filters.`}</strong><span>{isLoading ? "" : "Try another review status, time range, or search."}</span></div>}
    </div>
  </section>;
}
