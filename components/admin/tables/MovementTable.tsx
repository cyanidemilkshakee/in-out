import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { ResultPill } from '../../StatusPill';
import type { MovementEvent, SortDirection, VisibleColumn } from '../../../lib/types';

export function MovementTable({
  events,
  selectedId,
  visibleColumns,
  sortKey,
  sortDirection,
  density,
  onSort,
  onSelect
}: {
  events: MovementEvent[];
  selectedId?: string;
  visibleColumns: Record<VisibleColumn, boolean>;
  sortKey: VisibleColumn;
  sortDirection: SortDirection;
  density: "comfortable" | "compact";
  onSort: (column: VisibleColumn) => void;
  onSelect: (id: string) => void;
}) {
  const visibleColumnCount = Math.max(1, Object.values(visibleColumns).filter(Boolean).length);
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
            <ArrowUpDown size={16} style={{ color: "var(--muted)" }} />
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="table-wrap">
      <table className={`data-table movement-table resizable density-${density}`}>
        <thead>
          <tr>
            {visibleColumns.date ? sortHeader("date", "Date") : null}
            {visibleColumns.time ? sortHeader("time", "Time") : null}
            {visibleColumns.createdAt ? sortHeader("createdAt", "Created At") : null}
            {visibleColumns.name ? sortHeader("name", "Name") : null}
            {visibleColumns.type ? sortHeader("type", "Type") : null}
            {visibleColumns.direction ? sortHeader("direction", "Direction") : null}
            {visibleColumns.checkpoint ? sortHeader("checkpoint", "Checkpoint Name") : null}
            {visibleColumns.result ? sortHeader("result", "Result") : null}
            {visibleColumns.barcode ? sortHeader("barcode", "Barcode") : null}
            {visibleColumns.scanType ? sortHeader("scanType", "Scan Type") : null}
            {visibleColumns.eventId ? sortHeader("eventId", "Event ID") : null}
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
            <tr
              key={event.id}
              className={selectedId === event.id ? "selected" : ""}
              aria-selected={selectedId === event.id}
              onClick={() => onSelect(event.id)}
              style={{ cursor: "pointer" }}
            >
              {visibleColumns.date ? <td className="column-date" data-label="Date">{event.date}</td> : null}
              {visibleColumns.time ? <td className="column-time" data-label="Time">{event.time}</td> : null}
              {visibleColumns.createdAt ? <td className="column-createdAt" data-label="Created At">{event.createdAt}</td> : null}
              {visibleColumns.name ? <td className="column-name" data-label="Name">{event.subjectName}</td> : null}
              {visibleColumns.type ? <td className="column-type" data-label="Type" style={{ textTransform: "capitalize" }}>{event.subjectType}</td> : null}
              {visibleColumns.direction ? (
                <td className="column-direction" data-label="Direction">
                  <span className={`direction direction-${event.direction}`}>{event.direction}</span>
                </td>
              ) : null}
              {visibleColumns.checkpoint ? <td data-label="Checkpoint" className="column-checkpoint truncate">{event.checkpoint}</td> : null}
              {visibleColumns.result ? (
                <td className="column-result" data-label="Result">
                  <ResultPill value={event.result} />
                </td>
              ) : null}
              {visibleColumns.barcode ? <td className="column-barcode" data-label="Barcode" style={{ fontFamily: "monospace", fontSize: "0.9em" }}>{event.barcode}</td> : null}
              {visibleColumns.scanType ? <td className="column-scanType" data-label="Scan type" style={{ textTransform: "capitalize" }}>{event.scanType}</td> : null}
              {visibleColumns.eventId ? <td className="column-eventId" data-label="Event ID">{event.id}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
