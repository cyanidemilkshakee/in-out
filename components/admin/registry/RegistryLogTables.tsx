import type { Alert, AuditEvent } from "../../../lib/types";

function RecordTime({ date, time }: { date: string; time: string }) {
  return (
    <span className="registry-log-record">
      <strong>{date}</strong>
      <small>{time}</small>
    </span>
  );
}

export function AlertHistoryTable({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="table-wrap table-wrap-condensed registry-log-table-wrap">
      <table className="data-table data-table-condensed registry-log-table">
        <thead>
          <tr>
            <th>Date / time</th>
            <th>Alert</th>
            <th>Subject</th>
            <th>Severity</th>
            <th>Checkpoint</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty-table-cell">
                <div className="empty-state compact-empty">
                  <strong>No alert logs match this search.</strong>
                  <span>Clear the search to review the full alert history.</span>
                </div>
              </td>
            </tr>
          ) : null}
          {alerts.map((alert) => (
            <tr key={alert.id}>
              <td data-label="Date / time"><RecordTime date={alert.date} time={alert.time} /></td>
              <td data-label="Alert">
                <span className="registry-log-record">
                  <strong>{alert.title}</strong>
                  <small>{alert.ruleId ?? alert.category?.replaceAll("_", " ") ?? "Manual alert"}</small>
                </span>
              </td>
              <td data-label="Subject">
                <span className="registry-log-record"><strong>{alert.subjectName}</strong><small>{alert.barcode}</small></span>
              </td>
              <td data-label="Severity"><span className={`severity severity-${alert.severity}`}>{alert.severity}</span></td>
              <td data-label="Checkpoint">{alert.checkpoint}</td>
              <td data-label="Reason">{alert.reason}</td>
              <td data-label="Status"><span className={`alert-status alert-status-${alert.status}`}>{alert.status}</span></td>
              <td data-label="Reference" className="mono">{alert.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PermissionHistoryTable({ events }: { events: AuditEvent[] }) {
  return (
    <div className="table-wrap table-wrap-condensed registry-log-table-wrap">
      <table className="data-table data-table-condensed registry-log-table">
        <thead>
          <tr>
            <th>Date / time</th>
            <th>Subject</th>
            <th>Action</th>
            <th>Decision</th>
            <th>Actor</th>
            <th>Reason</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty-table-cell">
                <div className="empty-state compact-empty">
                  <strong>No permission logs match this search.</strong>
                  <span>Clear the search to review the full decision history.</span>
                </div>
              </td>
            </tr>
          ) : null}
          {events.map((event) => (
            <tr key={event.id}>
              <td data-label="Date / time"><RecordTime date={event.date} time={event.time} /></td>
              <td data-label="Subject"><span className="registry-log-record"><strong>{event.subjectName}</strong><small>{event.subjectId}</small></span></td>
              <td data-label="Action">{event.action}</td>
              <td data-label="Decision">
                <span className={`registry-decision registry-decision-${event.decision ?? "recorded"}`}>
                  {event.decision ?? "recorded"}
                </span>
              </td>
              <td data-label="Actor"><span className="registry-log-record"><strong>{event.actor}</strong><small>{event.role}</small></span></td>
              <td data-label="Reason">{event.reason}</td>
              <td data-label="Reference" className="mono">{event.relatedId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
