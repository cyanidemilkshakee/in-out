"use client";

import { useDeferredValue, useState, useMemo } from "react";
import { initialMovements, initialAlerts } from "../../../lib/mockData";
import type { MovementEvent, Alert, VisibleColumn, SortDirection, ResultStatus } from "../../../lib/types";
import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { MovementTable } from "../../../components/admin/tables/MovementTable";
import { DetailDrawer } from "../../../components/admin/tables/DetailDrawer";
import { TrendChart, type TimeRange } from "../../../components/analytics/TrendChart";

type StatusFilter = ResultStatus | "all" | "automatic" | "manual" | "entry" | "exit";

const defaultVisibleColumns: Record<VisibleColumn, boolean> = {
  date: true,
  time: true,
  name: true,
  type: true,
  direction: true,
  checkpoint: true,
  result: true,
  barcode: true,
  scanType: true,
  eventId: true
};

export default function LogsPage() {
  const [events] = useState<MovementEvent[]>(initialMovements);
  const [alerts] = useState<Alert[]>(initialAlerts);
  const [search, setSearch] = useState("");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const rowsPerPage = 25;
  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedEventId, setSelectedEventId] = useState(initialMovements[0]?.id ?? "");
  const [eventNotes, setEventNotes] = useState<Record<string, string[]>>({});
  const [drawerDraft, setDrawerDraft] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const deferredSearch = useDeferredValue(search);

  const filteredEvents = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return events.filter((event) => {
      const checkpointMatch =
        checkpointFilter === "all" || event.checkpoint === checkpointFilter;
      const statusMatch =
        statusFilter === "all" ||
        event.result === statusFilter ||
        event.scanType === statusFilter ||
        event.direction === statusFilter;
      const searchMatch =
        !needle ||
        [event.subjectName, event.barcode, event.checkpoint, event.scanType, event.result]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return checkpointMatch && statusMatch && searchMatch;
    });
  }, [checkpointFilter, deferredSearch, events, statusFilter]);

  const pagedEvents = useMemo(() => {
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
        date: event.date,
        time: timeValue(event.time),
        name: event.subjectName,
        type: event.subjectType,
        direction: event.direction,
        checkpoint: event.checkpoint,
        result: event.result,
        barcode: event.barcode,
        scanType: event.scanType ?? "",
        eventId: event.id
      };
      return values[key];
    };

    const start = (page - 1) * rowsPerPage;
    return [...filteredEvents].sort((a, b) => {
      const aVal = valueFor(a, sortKey);
      const bVal = valueFor(b, sortKey);
      if (aVal === bVal) return 0;
      const greater = aVal > bVal;
      return sortDirection === "asc" ? (greater ? 1 : -1) : greater ? -1 : 1;
    }).slice(start, start + rowsPerPage);
  }, [filteredEvents, page, rowsPerPage, sortDirection, sortKey]);

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

  const selectedEvent = useMemo(() => events.find((e) => e.id === selectedEventId), [events, selectedEventId]);
  const selectedAlert = useMemo(() => alerts.find((a) => a.id === selectedEventId), [alerts, selectedEventId]);
  const uniqueCheckpoints = useMemo(() => Array.from(new Set(events.map(e => e.checkpoint))).sort(), [events]);

  return (
    <AdminPageFrame
      title="Movement Ledger"
      description="Search every entry, exit, denial, and offline movement with row-level review for security handoff."
      headerRight={<TrendChart events={filteredEvents} timeRange={timeRange} onTimeRangeChange={setTimeRange} />}
    >
    <section className="split-workspace log-workspace">
      <div className="workspace-main">


        <div className="filter-bar">
          <label className="select-control">
            <span className="sr-only">Filter by time</span>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            >
              <option value="1Y">Last 1 Year</option>
              <option value="1M">Last 1 Month</option>
              <option value="1W">Last 1 Week</option>
              <option value="1D">Last 24 Hours</option>
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by checkpoint</span>
            <select
              value={checkpointFilter}
              onChange={(e) => setCheckpointFilter(e.target.value)}
            >
              <option value="all">All Checkpoints</option>
              {uniqueCheckpoints.map(cp => <option key={cp} value={cp}>{cp}</option>)}
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">All Results</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="automatic">Automatic</option>
              <option value="manual">Manual</option>
              <option value="entry">Entry</option>
              <option value="exit">Exit</option>
            </select>
          </label>
          <label className="search-control" style={{ marginLeft: 'auto' }}>
            <span className="sr-only">Search events</span>
            <input
              type="search"
              placeholder="Search subjects, barcodes, reasons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>

        <MovementTable
          events={pagedEvents}
          selectedId={selectedEventId}
          visibleColumns={defaultVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="compact"
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
    </AdminPageFrame>
  );
}
