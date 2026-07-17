import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Alert } from '../../../lib/types';

export function AlertsView({
  alerts,
  onUpdate
}: {
  alerts: Alert[];
  onUpdate: (alertId: string, status: Alert["status"]) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof Alert>("time");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const sortedAlerts = useMemo(() => {
    return [...alerts].sort((a, b) => {
      const aValue = String(a[sortKey] ?? "");
      const bValue = String(b[sortKey] ?? "");
      return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    });
  }, [alerts, sortDirection, sortKey]);

  function sortHeader(column: keyof Alert, label: string) {
    const active = sortKey === column;
    return (
      <th
        className={`column-${String(column)}`}
        aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          className="sort-button"
          type="button"
          onClick={() => {
            setSortDirection(active && sortDirection === "asc" ? "desc" : "asc");
            setSortKey(column);
          }}
        >
          <span>{label}</span>
          {active ? (sortDirection === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />) : <ArrowUpDown size={16} />}
        </button>
      </th>
    );
  }

  return (
    <div className="table-wrap table-wrap-condensed">
      <table className="data-table data-table-condensed alerts-table">
        <thead>
          <tr>
            {sortHeader("id", "ID")}
            {sortHeader("severity", "Severity")}
            {sortHeader("status", "Status")}
            {sortHeader("subjectName", "Subject")}
            {sortHeader("barcode", "Barcode")}
            {sortHeader("checkpoint", "Checkpoint")}
            {sortHeader("reason", "Reason")}
            <th className="column-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty-table-cell">
                <div className="empty-state compact-empty">
                  <strong>No alerts match this severity.</strong>
                  <span>Try all severities or review resolved alerts later.</span>
                </div>
              </td>
            </tr>
          ) : null}
          {sortedAlerts.map((alert) => (
            <tr key={alert.id}>
              <td className="column-id" data-label="ID">{alert.id}</td>
              <td className="column-severity" data-label="Severity">
                <span className={`severity severity-${alert.severity}`}>{alert.severity}</span>
              </td>
              <td className="column-status" data-label="Status">
                <span className={`alert-status alert-status-${alert.status}`}>{alert.status}</span>
              </td>
              <td className="column-subjectName" data-label="Subject">{alert.subjectName}</td>
              <td className="column-barcode" data-label="Barcode">{alert.barcode}</td>
              <td className="column-checkpoint" data-label="Checkpoint">{alert.checkpoint}</td>
              <td className="column-reason" data-label="Reason">{alert.reason}</td>
              <td data-label="Actions" className="column-actions row-actions">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => onUpdate(alert.id, "resolved")}
                >
                  Resolve
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
