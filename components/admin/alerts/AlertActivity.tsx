"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { Alert } from "../../../lib/types";

function alertTimestamp(alert: Alert) {
  const value = alert.createdAt
    ? new Date(alert.createdAt).getTime()
    : new Date(`${alert.date} ${alert.time}`).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function AlertActivity({
  alerts,
  onUpdate,
}: {
  alerts: Alert[];
  onUpdate: (alertId: string, status: Alert["status"]) => void;
}) {
  const sortedAlerts = useMemo(
    () => [...alerts].sort((a, b) => alertTimestamp(b) - alertTimestamp(a)),
    [alerts]
  );

  return (
    <section className="alert-activity-section" aria-labelledby="alert-activity-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-activity-title">Active alerts</h2>
          <p>Open and acknowledged conditions requiring security action.</p>
        </div>
        <span>{sortedAlerts.length} active</span>
      </div>
      <div className="alert-activity-list">
        {sortedAlerts.length ? sortedAlerts.map((alert) => (
          <article key={alert.id}>
            <time><strong>{alert.time}</strong><small>{alert.date}</small></time>
            <span className="alert-activity-dot" data-severity={alert.severity} aria-hidden="true" />
            <span className="alert-activity-copy">
              <span className="alert-activity-title-row">
                <strong>{alert.title}</strong>
                <span className={`severity severity-${alert.severity}`}>{alert.severity}</span>
              </span>
              <small>{alert.subjectName} / {alert.checkpoint}</small>
              <p>{alert.reason}</p>
              {alert.explanation ? <em>{alert.explanation}</em> : null}
            </span>
            <span className="alert-activity-actions">
              <span className={`alert-status alert-status-${alert.status}`}>{alert.status}</span>
              {alert.status === "resolved" ? (
                <span className="alert-complete"><CheckCircle2 size={15} /> Resolved</span>
              ) : (
                <>
                  {alert.status === "open" ? (
                    <button type="button" onClick={() => onUpdate(alert.id, "acknowledged")}>Acknowledge</button>
                  ) : null}
                  <button type="button" onClick={() => onUpdate(alert.id, "resolved")}>Resolve</button>
                </>
              )}
            </span>
          </article>
        )) : (
          <div className="alert-activity-empty">
            <AlertTriangle size={22} />
            <strong>No active alerts match this search.</strong>
            <span>Clear the search or review alert history in Registry.</span>
          </div>
        )}
      </div>
    </section>
  );
}
