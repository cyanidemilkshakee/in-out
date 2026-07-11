"use client";

import { useState, useMemo } from "react";
import { Filter, Columns3 } from "lucide-react";
import { initialMovements, initialAlerts } from "../../../lib/mockData";
import type { MovementEvent, Alert, VisibleColumn, SortDirection, ResultStatus } from "../../../lib/types";
import { MovementTable, DetailDrawer } from "../../../components/admin/Tables";

type StatusFilter = ResultStatus | "all" | "exceptions" | "queued";

const defaultVisibleColumns: Record<VisibleColumn, boolean> = {
  time: true,
  checkpoint: true,
  direction: true,
  subject: true,
  type: true,
  barcode: true,
  result: true,
  reason: true,
  scanner: true,
  sync: true
};

export default function LogsPage() {
  const [events, setEvents] = useState<MovementEvent[]>(initialMovements);
  const [alerts] = useState<Alert[]>(initialAlerts);
  const [search, setSearch] = useState("");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [rowsPerPage] = useState(25);
  const [showColumns, setShowColumns] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(defaultVisibleColumns);
  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [tableDensity, setTableDensity] = useState<"comfortable" | "compact">("comfortable");
  const [selectedEventId, setSelectedEventId] = useState(initialMovements[0]?.id ?? "");
  const [eventNotes, setEventNotes] = useState<Record<string, string[]>>({});
  const [drawerDraft, setDrawerDraft] = useState("");

  const filteredEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      const checkpointMatch =
        checkpointFilter === "all" || event.checkpointId === checkpointFilter;
      const statusMatch =
        statusFilter === "all" ||
        (statusFilter === "exceptions" && event.result !== "success") ||
        (statusFilter === "queued" && event.syncState !== "synced") ||
        event.result === statusFilter;
      const searchMatch =
        !needle ||
        [event.subjectName, event.barcode, event.checkpoint, event.scannerId, event.reason]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return checkpointMatch && statusMatch && searchMatch;
    });
  }, [checkpointFilter, events, search, statusFilter]);

  const sortedEvents = useMemo(() => {
    const timeValue = (time: string) => {
      const match = time.match(/^(\d{1,2}):(\d{2}):(\d{2})\s(AM|PM)$/);
      if (!match) {
        return time;
      }
      const [, rawHour, minute, second, period] = match;
      const hour = (Number(rawHour) % 12) + (period === "PM" ? 12 : 0);
      return hour * 3600 + Number(minute) * 60 + Number(second);
    };

    const valueFor = (event: MovementEvent, key: VisibleColumn) => {
      const values: Record<VisibleColumn, string | number> = {
        time: timeValue(event.time),
        checkpoint: event.checkpoint,
        direction: event.direction,
        subject: event.subjectName,
        type: event.subjectType,
        barcode: event.barcode,
        result: event.result,
        reason: event.reason,
        scanner: event.scannerId,
        sync: event.syncState
      };
      return values[key];
    };

    return [...filteredEvents].sort((a, b) => {
      const aVal = valueFor(a, sortKey);
      const bVal = valueFor(b, sortKey);
      if (aVal === bVal) return 0;
      const greater = aVal > bVal;
      return sortDirection === "asc" ? (greater ? 1 : -1) : greater ? -1 : 1;
    });
  }, [filteredEvents, sortDirection, sortKey]);

  function clearFilters() {
    setCheckpointFilter("all");
    setStatusFilter("all");
    setSearch("");
    setPage(1);
  }

  function updateSort(column: VisibleColumn) {
    setSortKey(column);
    setSortDirection((current) => (sortKey === column && current === "asc" ? "desc" : "asc"));
  }

  function handleSaveNote(eventId: string) {
    const trimmed = drawerDraft.trim();
    if (!trimmed) return;
    setEventNotes((current) => ({
      ...current,
      [eventId]: [...(current[eventId] ?? []), trimmed]
    }));
    setDrawerDraft("");
  }

  const selectedEvent = events.find((e) => e.id === selectedEventId);
  const selectedAlert = alerts.find((a) => a.id === selectedEventId);

  return (
    <section className="split-workspace" style={{ display: 'flex', height: '100%' }}>
      <div className="workspace-main" style={{ flex: 1, padding: '24px' }}>
        <div className="panel-titlebar">
          <div>
            <h1>Log Explorer</h1>
            <p>
              Showing {Math.min(filteredEvents.length, (page - 1) * rowsPerPage + 1)} to{" "}
              {Math.min(filteredEvents.length, page * rowsPerPage)} of{" "}
              {filteredEvents.length} results
            </p>
          </div>
          <div className="toolbar">
            <button className="ghost-button" type="button" onClick={clearFilters}>
              <Filter />
              Filters
            </button>
            <div className="column-menu" style={{ position: 'relative' }}>
              <button
                className="ghost-button"
                type="button"
                onClick={() => setShowColumns((value) => !value)}
              >
                <Columns3 />
                Columns
              </button>
              {showColumns ? (
                <div className="popover" style={{ position: 'absolute', top: '100%', right: 0, background: 'white', border: '1px solid #ccc', padding: '10px', zIndex: 10 }}>
                  {(Object.keys(visibleColumns) as VisibleColumn[]).map((column) => (
                    <label key={column} className="checkbox-row" style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={visibleColumns[column]}
                        onChange={() =>
                          setVisibleColumns((current) => ({
                            ...current,
                            [column]: !current[column]
                          }))
                        }
                      />
                      {column}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="density-toggle" aria-label="Table density">
              <button
                className={tableDensity === "comfortable" ? "segmented active" : "segmented"}
                type="button"
                aria-pressed={tableDensity === "comfortable"}
                onClick={() => setTableDensity("comfortable")}
              >
                Comfortable
              </button>
              <button
                className={tableDensity === "compact" ? "segmented active" : "segmented"}
                type="button"
                aria-pressed={tableDensity === "compact"}
                onClick={() => setTableDensity("compact")}
              >
                Compact
              </button>
            </div>
          </div>
        </div>

        <div className="filter-bar">
          <label className="search-control">
            <span className="sr-only">Search events</span>
            <input
              type="search"
              placeholder="Search subjects, barcodes, reasons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">All Results</option>
              <option value="success">Success</option>
              <option value="exceptions">Exceptions</option>
              <option value="denied">Denied</option>
              <option value="restricted">Restricted</option>
              <option value="queued">Queued</option>
            </select>
          </label>
        </div>

        <MovementTable
          events={sortedEvents.slice((page - 1) * rowsPerPage, page * rowsPerPage)}
          selectedId={selectedEventId}
          visibleColumns={visibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density={tableDensity}
          onSort={updateSort}
          onSelect={setSelectedEventId}
        />
        
        <div className="pagination">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>Page {page} of {Math.ceil(filteredEvents.length / rowsPerPage) || 1}</span>
          <button
            type="button"
            disabled={page >= Math.ceil(filteredEvents.length / rowsPerPage)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {selectedEvent ? (
        <DetailDrawer
          alert={selectedAlert}
          event={selectedEvent}
          notes={eventNotes[selectedEvent.id] ?? []}
          noteDraft={drawerDraft}
          onNoteDraftChange={setDrawerDraft}
          onAddNote={() => handleSaveNote(selectedEvent.id)}
          onAcknowledge={() => {}}
          onResolve={() => {}}
          onClose={() => setSelectedEventId("")}
        />
      ) : null}
    </section>
  );
}
