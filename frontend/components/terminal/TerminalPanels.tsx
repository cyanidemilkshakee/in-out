"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Clock3, Loader2, X } from "lucide-react";
import type { MovementEvent, PermissionRequest } from "../../../lib/types";
import styles from "./SecurityTerminal.module.css";
import { formatRequestDate } from "../admin/permissions/requestPresentation";
import { useDateTimeNow } from "../../hooks/useDateTimeNow";
import { ManualReviewCountdown } from "../ManualReviewCountdown";

export function formatTerminalTime(timestamp?: string, fallback?: string) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || !Number.isFinite(date.getTime())) return fallback || "—";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function Status({ status, children }: { status: string; children: ReactNode }) {
  return <span className={styles.status} data-status={status}><span aria-hidden="true" />{children}</span>;
}

export function TerminalActivity({ movements, requests }: { movements: MovementEvent[]; requests: PermissionRequest[] }) {
  const pending = requests.filter((request) => request.status === "pending").length;
  const recent = movements.slice(0, 8);
  const manualApprovals = useMemo(() => requests.filter((request) => !request.notificationDismissedAt).sort((a, b) =>
    Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt)
  ).slice(0, 8), [requests]);
  const now = useDateTimeNow(manualApprovals.some((request) =>
    request.type === "manual_override" && request.status === "approved" && !request.consumedAt && Boolean(request.validTo)
  ));

  return (
    <section className={styles.activity} aria-label="Checkpoint activity">
      <section className={styles.activityColumn} aria-labelledby="recent-scans-title">
        <div className={styles.activityHeader}>
          <h2 id="recent-scans-title">Recent scans</h2>
          <span className={styles.activityHint}>At this checkpoint</span>
        </div>
        {recent.length ? <div className={styles.tableScroll}>
          <table className={styles.activityTable}>
            <caption className={styles.srOnly}>Recent scans at the selected checkpoint</caption>
            <thead><tr><th scope="col">Person or asset</th><th scope="col">Movement</th><th scope="col">Result</th><th scope="col">Time</th></tr></thead>
            <tbody>
              {recent.map((movement) => (
                <tr key={movement.id}>
                  <td><strong>{movement.subjectName || "Unregistered barcode"}</strong><small>{movement.barcode}</small></td>
                  <td><span className={styles.direction} data-direction={movement.direction}>{movement.direction === "entry" ? <ArrowDownLeft /> : <ArrowUpRight />}{movement.direction === "entry" ? "Entry" : "Exit"}</span></td>
                  <td><Status status={movement.result}>{movement.result === "approved" ? "Allowed" : "Denied"}</Status></td>
                  <td className={styles.time}>{formatTerminalTime(movement.createdAt, movement.time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div> : <div className={styles.emptyActivity}>Scans at this checkpoint will appear here.</div>}
      </section>

      <section className={styles.activityColumn} aria-labelledby="manual-approvals-title">
        <div className={styles.activityHeader}>
          <h2 id="manual-approvals-title">Manual approvals{pending > 0 && <span className={styles.count} aria-label={`${pending} pending`}>{pending}</span>}</h2>
          <span className={styles.activityHint}>At this checkpoint</span>
        </div>
        {manualApprovals.length ? <div className={styles.tableScroll}>
          <table className={styles.activityTable}>
            <caption className={styles.srOnly}>Manual approvals at the selected checkpoint</caption>
            <thead><tr><th scope="col">Person or asset</th><th scope="col">Movement</th><th scope="col">Status</th><th scope="col">Time</th></tr></thead>
            <tbody>
              {manualApprovals.map((request) => {
                const manualApproval = request.type === "manual_override";
                const expired = manualApproval && request.status === "approved" && !request.consumedAt &&
                  Boolean(request.validTo) && Date.parse(request.validTo!) <= now.getTime();
                const label = request.status === "pending" ? "Waiting" : request.status === "denied" ? "Denied" :
                  !manualApproval ? "Approved" : request.consumedAt ? "Used" : expired ? "Expired" : "Rescan";
                return <tr key={request.id}>
                  <td><strong>{request.subjectName || "Unregistered barcode"}</strong><small>{request.operatorNote || "No note"}</small></td>
                  <td><span className={styles.direction} data-direction={request.direction}>{request.direction === "exit" ? <ArrowUpRight /> : <ArrowDownLeft />}{request.direction === "exit" ? "Exit" : "Entry"}</span></td>
                  <td className={styles.reviewStatus}>
                    <Status status={expired ? "denied" : request.status}>{label}</Status>
                    {manualApproval && request.status === "pending" ? <ManualReviewCountdown createdAt={request.createdAt} /> : null}
                  </td>
                  <td className={styles.time}>{formatTerminalTime(request.createdAt)}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div> : <div className={styles.emptyActivity}>No manual approvals at this checkpoint.</div>}
      </section>
    </section>
  );
}

export function TerminalNotifications({
  requests,
  onDismiss,
  dismissingId,
  dismissError,
}: {
  requests: PermissionRequest[];
  onDismiss: (requestId: string) => Promise<void>;
  dismissingId: string | null;
  dismissError: string;
}) {
  const visibleRequests = useMemo(() => requests
    .filter((request) => request.status === "pending" || !request.notificationDismissedAt)
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") ||
      (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)), [requests]);
  const now = useDateTimeNow(visibleRequests.some((request) =>
    request.type === "manual_override" && request.status === "approved" && !request.consumedAt && Boolean(request.validTo)
  ));

  return (
    <aside className={styles.pendingPanel} aria-labelledby="permission-notifications-title">
      <header className={styles.pendingPanelHeader}>
        <h2 id="permission-notifications-title">Permission notifications</h2>
      </header>
      {dismissError && <p className={styles.notificationError} role="alert">{dismissError}</p>}
      {visibleRequests.length ? <ul className={`${styles.pendingList} ${styles.notificationList}`} aria-live="polite" aria-relevant="additions text">
        {visibleRequests.map((request) => {
          const hasDecision = request.status === "approved" || request.status === "denied";
          const direction = request.direction === "exit" ? "Exit" : "Entry";
          const approvalExpired = request.status === "approved" && !request.consumedAt &&
            Boolean(request.validTo) && Date.parse(request.validTo) <= now.getTime();
          const approvalReady = request.type === "manual_override" && request.status === "approved" && !request.consumedAt && !approvalExpired;
          const note = approvalReady
            ? `Rescan at this checkpoint before ${formatRequestDate(request.validTo)}. This approval allows one ${direction.toLowerCase()}.`
            : approvalExpired
              ? `Approval expired at ${formatRequestDate(request.validTo)}. Request a new review.`
              : request.consumedAt
                ? `Approval used at ${formatTerminalTime(request.consumedAt)}.`
                : hasDecision ? request.decisionReason || (request.status === "approved" ? "Permission approved." : "Permission denied.") : request.operatorNote;
          const timestamp = hasDecision ? request.decidedAt ?? request.createdAt : request.createdAt;
          const dismissing = dismissingId === request.id;
          const statusLabel = request.status === "approved"
            ? request.consumedAt ? "Used" : approvalExpired ? "Expired" : approvalReady ? "Rescan" : "Approved"
            : request.status === "denied" ? `${direction} denied` : "Awaiting decision";
          return <li key={request.id}>
            <div className={styles.pendingIdentityGroup}>
              <span className={styles.pendingStatusIcon} data-status={approvalExpired ? "denied" : request.status} aria-hidden="true">
                {approvalExpired || request.status === "denied" ? <X /> : request.status === "approved" ? <Check /> : <Clock3 />}
              </span>
              <div className={styles.pendingIdentity}>
                <div className={styles.notificationMeta}>
                  <Status status={approvalExpired ? "denied" : request.status}>{statusLabel}</Status>
                  <time dateTime={timestamp}>{formatTerminalTime(timestamp)}</time>
                </div>
                <strong>{request.subjectName || "Unregistered barcode"}<span>{request.barcode}</span></strong>
                {note ? <span className={styles.pendingNote}>{note}</span> : null}
                {request.type === "manual_override" && request.status === "pending" ? <ManualReviewCountdown createdAt={request.createdAt} /> : null}
              </div>
            </div>
            {hasDecision && <button className={styles.notificationDismiss} type="button" disabled={dismissingId !== null}
              aria-label={`Dismiss ${request.status === "approved" ? "approval" : "denial"} notification for ${request.barcode || request.subjectName || "unregistered barcode"}`}
              aria-busy={dismissing} title={dismissing ? "Dismissing notification…" : "Dismiss notification"}
              onClick={() => void onDismiss(request.id)}>
              {dismissing ? <Loader2 className={styles.spin} aria-hidden="true" /> : <X aria-hidden="true" />}
            </button>}
          </li>;
        })}
      </ul> : <div className={styles.pendingEmpty}>
        <strong>No permission updates</strong>
        <p>Pending requests and new decisions appear here.</p>
      </div>}
    </aside>
  );
}
