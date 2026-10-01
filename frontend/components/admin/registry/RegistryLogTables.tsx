import type { AuditEvent } from "../../../../lib/types";

function RecordTime({ createdAt, date, time }: Pick<AuditEvent, "createdAt" | "date" | "time">) {
  const timestamp = new Date(createdAt).getTime();
  const recordedAt = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  const dateLabel = date || recordedAt?.toLocaleDateString("en-IN", { dateStyle: "medium" }) || "Not recorded";
  const timeLabel = time || recordedAt?.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) || "";
  return (
    <span className="registry-record">
      <strong>{dateLabel}</strong>
      {timeLabel ? <small>{timeLabel}</small> : null}
    </span>
  );
}

export function PermissionHistoryTable({ events }: { events: AuditEvent[] }) {
  return (
    <div className="admin-table-wrap table-wrap table-wrap-condensed registry-table-wrap">
      <table className="data-table data-table-condensed registry-table registry-table--permissions">
        <thead>
          <tr>
            <th>Recorded</th>
            <th>Person or asset</th>
            <th>Decision</th>
            <th>Permission</th>
            <th>Reviewed by</th>
            <th>Decision note</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty-table-cell">
                <div className="empty-state compact-empty">
                  <strong>No permission decisions match this search.</strong>
                  <span>Completed manual access decisions will appear here.</span>
                </div>
              </td>
            </tr>
          ) : null}
          {events.map((event) => (
            <tr key={event.id}>
              <td data-label="Recorded"><RecordTime createdAt={event.createdAt} date={event.date} time={event.time} /></td>
              <td data-label="Person or asset">
                <span className="registry-record">
                  <strong>{event.subjectName || "Unregistered barcode"}</strong>
                  <small>{event.barcode || event.subjectId || "No barcode recorded"}</small>
                </span>
              </td>
              <td data-label="Decision">
                <span className={`registry-decision registry-decision-${event.decision ?? "recorded"}`}>
                  {event.decision === "granted" ? "Allowed" : event.decision === "denied" ? "Denied" : "Updated"}
                </span>
              </td>
              <td data-label="Permission">{event.action || "Permission update"}</td>
              <td data-label="Reviewed by"><span className="registry-record"><strong>{event.actor || "Administrator"}</strong><small>{event.role || "Administrator"}</small></span></td>
              <td data-label="Decision note">{event.reason || "No note recorded"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
