"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, Clock3, X } from "lucide-react";
import type { MovementEvent, PermissionRequest } from "../../../lib/types";
import styles from "./SecurityTerminal.module.css";

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
  const manualApprovals = useMemo(() => [...requests].sort((a, b) =>
    Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt)
  ).slice(0, 8), [requests]);

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
              {manualApprovals.map((request) => (
                <tr key={request.id}>
                  <td><strong>{request.subjectName || "Unregistered barcode"}</strong><small>{request.operatorNote || "No note"}</small></td>
                  <td><span className={styles.direction} data-direction={request.direction}>{request.direction === "exit" ? <ArrowUpRight /> : <ArrowDownLeft />}{request.direction === "exit" ? "Exit" : "Entry"}</span></td>
                  <td><Status status={request.status}>{request.status === "pending" ? "Waiting" : request.status === "approved" ? "Approved" : "Denied"}</Status></td>
                  <td className={styles.time}>{formatTerminalTime(request.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div> : <div className={styles.emptyActivity}>No manual approvals at this checkpoint.</div>}
      </section>
    </section>
  );
}

export function PendingPermissions({
  requests,
  onAcknowledge,
  acknowledgingId,
}: {
  requests: PermissionRequest[];
  onAcknowledge: (requestId: string) => Promise<void>;
  acknowledgingId: string | null;
}) {
  const visibleRequests = useMemo(() => requests
    .filter((request) => request.status === "pending" || (request.terminalAcknowledgementRequired && !request.acknowledgedAt))
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3), [requests]);

  return (
    <aside className={styles.pendingPanel} aria-labelledby="pending-permissions-title">
      <header className={styles.pendingPanelHeader}>
        <h2 id="pending-permissions-title">Pending permissions</h2>
        <ArrowRight aria-hidden="true" />
      </header>
      {visibleRequests.length ? <ul className={styles.pendingList}>
        {visibleRequests.map((request) => {
          const hasDecision = request.status === "approved" || request.status === "denied";
          const note = request.status === "denied" ? request.decisionReason : request.decisionReason || request.operatorNote;
          return <li key={request.id}>
            <div className={styles.pendingIdentityGroup}>
              <span className={styles.pendingStatusIcon} data-status={request.status} aria-hidden="true">
                {request.status === "approved" ? <Check /> : request.status === "denied" ? <X /> : <Clock3 />}
              </span>
              <div className={styles.pendingIdentity}>
                <strong>{request.subjectName || "Unregistered barcode"}<span>{request.barcode}</span></strong>
                {note ? <span className={styles.pendingNote}>{note}</span> : null}
              </div>
            </div>
            {hasDecision && <div className={styles.pendingResolution}>
              <Status status={request.status}>{request.status === "approved" ? "Approved" : "Denied"}</Status>
              <button type="button" disabled={acknowledgingId === request.id} onClick={() => void onAcknowledge(request.id)}>{acknowledgingId === request.id ? "Saving…" : "Ack"}</button>
            </div>}
          </li>;
        })}
      </ul> : <div className={styles.pendingEmpty}>
        <strong>No pending permissions</strong>
        <p>All permission requests are up to date.</p>
      </div>}
    </aside>
  );
}
