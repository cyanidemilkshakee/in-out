import { Fragment } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type {
  MovementEvent,
  Person,
  ResultStatus,
  SortDirection,
  VisibleColumn,
} from '../../../../lib/types';

function ResultPill({ value }: { value: ResultStatus }) {
  return (
    <span className={`pill result-${value}`}>
      {value === "approved" ? "Approved" : "Denied"}
    </span>
  );
}

export function MovementTable({
  events,
  people,
  visibleColumns,
  sortKey,
  sortDirection,
  density,
  layout = "default",
  onSort
}: {
  events: MovementEvent[];
  people: Person[];
  visibleColumns: Record<VisibleColumn, boolean>;
  sortKey: VisibleColumn;
  sortDirection: SortDirection;
  density: "comfortable" | "compact";
  layout?: "default" | "logs";
  onSort: (column: VisibleColumn) => void;
}) {
  const visibleColumnCount = Math.max(1, Object.values(visibleColumns).filter(Boolean).length);
  const peopleById = new Map(people.map((person) => [person.id, person] as const));
  const columnOrder: VisibleColumn[] = layout === "logs"
    ? ["date", "time", "name", "type", "result", "checkpoint", "scanType", "direction", "active", "barcode"]
    : ["date", "time", "createdAt", "name", "active", "type", "direction", "checkpoint", "result", "barcode", "scanType", "eventId"];

  const sortHeader = (column: VisibleColumn, label: string) => {
    const isSorted = sortKey === column;
    return (
      <th
        className={`column-${column}`}
        aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button className="sort-button" type="button" onClick={() => onSort(column)}>
          <span>{label}</span>
          {isSorted ? (
            sortDirection === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />
          ) : (
            <ArrowUpDown className="sort-icon-muted" size={16} />
          )}
        </button>
      </th>
    );
  };

  const renderHeader = (column: VisibleColumn) => {
    if (!visibleColumns[column]) return null;
    if (column === "active") return <th key={column} className="column-active">Status</th>;
    const labels: Record<Exclude<VisibleColumn, "active">, string> = {
      date: "Date",
      time: "Time",
      createdAt: "Created At",
      name: "Name",
      type: "Type",
      direction: "Direction",
      checkpoint: "Checkpoint Name",
      result: "Result",
      barcode: layout === "logs" ? "Barcode ID" : "Barcode",
      scanType: "Scan Type",
      eventId: "Event ID",
    };
    return <Fragment key={column}>{sortHeader(column, labels[column])}</Fragment>;
  };

  const renderStatus = (event: MovementEvent) => {
    const person = peopleById.get(event.subjectId);
    if (!person || person.type !== event.subjectType) return "—";
    const label = person.type === "employee"
      ? person.status === "active" ? "Active" : "Inactive"
      : person.status === "pre_approved" ? "Pre-approved"
        : person.status === "expired" ? "Expired"
          : person.status.replaceAll("_", " ");
    const isPositive = person.type === "employee"
      ? person.status === "active"
      : person.status === "pre_approved";
    return (
      <span className={`registry-presence employee-status-label ${isPositive ? "is-inside" : "is-outside"}`}>
        {label}
      </span>
    );
  };

  const renderCell = (column: VisibleColumn, event: MovementEvent) => {
    if (!visibleColumns[column]) return null;
    switch (column) {
      case "date": return <td key={column} className="column-date" data-label="Date">{event.date}</td>;
      case "time": return <td key={column} className="column-time" data-label="Time">{event.time}</td>;
      case "createdAt": return <td key={column} className="column-createdAt" data-label="Created At">{event.createdAt}</td>;
      case "name": return <td key={column} className="column-name" data-label="Name">{event.subjectName}</td>;
      case "active": return <td key={column} className="column-active" data-label="Status">{renderStatus(event)}</td>;
      case "type": return <td key={column} className="column-type cell-capitalize" data-label="Type">{event.subjectType}</td>;
      case "result": return <td key={column} className="column-result" data-label="Result"><ResultPill value={event.result} /></td>;
      case "checkpoint": return <td key={column} className="column-checkpoint truncate" data-label="Checkpoint Name">{event.checkpoint}</td>;
      case "scanType": return <td key={column} className="column-scanType cell-capitalize" data-label="Scan Type">{event.scanType}</td>;
      case "direction": return <td key={column} className="column-direction" data-label="Direction"><span className={`direction direction-${event.direction}`}>{event.direction}</span></td>;
      case "barcode": return <td key={column} className="column-barcode cell-barcode" data-label="Barcode ID">{event.barcode}</td>;
      case "eventId": return <td key={column} className="column-eventId" data-label="Event ID">{event.id}</td>;
      default: return null;
    }
  };

  return (
    <div className="admin-table-wrap table-wrap">
      <table className={`data-table movement-table resizable density-${density}${layout === "logs" ? " movement-table--logs" : ""}`}>
        <thead>
          <tr>
            {columnOrder.map(renderHeader)}
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colSpan={visibleColumnCount} className="empty-table-cell">
                <div className="empty-state compact-empty">
                  <strong>No movement events match these filters.</strong>
                  <span>Clear filters or try a wider search term.</span>
                </div>
              </td>
            </tr>
          ) : null}
          {events.map((event) => (
            <tr key={event.id}>
              {columnOrder.map((column) => renderCell(column, event))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
