"use client";

import dynamic from "next/dynamic";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MovementPage,
  VisibleColumn,
  SortDirection,
  ResultStatus,
} from "../../../lib/types";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { MovementTable } from "../../../frontend/components/admin/tables/MovementTable";
import type { TimeRange } from "../../../frontend/components/analytics/TrendChart";
import { CalendarDatePicker } from "../../../frontend/components/analytics/CalendarDatePicker";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import {
  compactRangeBounds,
  parseDateInput,
} from "../../../lib/dateRanges";

const TrendChart = dynamic(
  () =>
    import("../../../frontend/components/analytics/TrendChart").then(
      (module) => module.TrendChart
    ),
  { ssr: false }
);
const ReportBuilder = dynamic(
  () =>
    import("../../../frontend/components/admin/reports/ReportBuilder").then(
      (module) => module.ReportBuilder
    ),
  { ssr: false }
);
const DetailDrawer = dynamic(
  () =>
    import("../../../frontend/components/admin/tables/DetailDrawer").then(
      (module) => module.DetailDrawer
    ),
  { ssr: false }
);

type StatusFilter = ResultStatus | "all";

const defaultVisibleColumns: Record<VisibleColumn, boolean> = {
  date: true,
  time: true,
  createdAt: false,
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
  const {
    movements: initialEvents,
    movementPage: initialMovementPage,
    alerts,
    auditEvents,
    movementNotes: initialEventNotes,
  } = useDataState();
  const { addMovementNote, queryMovements, updateAlert } = useDataActions();
  const [search, setSearch] = useState("");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [scanTypeFilter, setScanTypeFilter] = useState<"all" | "auto" | "manual">("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | "entry" | "exit">("all");
  const [subjectTypeFilter, setSubjectTypeFilter] = useState<"people" | "hardware">("people");
  const [page, setPage] = useState(1);
  const rowsPerPage = 25;
  const [sortKey, setSortKey] = useState<VisibleColumn>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedEventId, setSelectedEventId] = useState(
    initialEvents[0]?.id ?? ""
  );
  const [drawerDraft, setDrawerDraft] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("1D");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filtersReady, setFiltersReady] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [movementPage, setMovementPage] = useState<MovementPage>(() => ({
    ...(initialMovementPage ?? {
      items: initialEvents,
      chartItems: initialEvents,
      movementNotes: initialEventNotes,
      total: initialEvents.length,
      page: 1,
      pageSize: rowsPerPage,
      checkpoints: Array.from(
        new Set(initialEvents.map((event) => event.checkpoint))
      ).sort(),
    }),
  }));
  const [queryError, setQueryError] = useState("");
  const initialQueryPending = useRef(Boolean(initialMovementPage));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const subject = params.get("subject");
    const result = params.get("result");
    const scanType = params.get("scanType");
    const direction = params.get("direction");
    const reason = params.get("reason");
    if ([subject, result, scanType, direction, reason].some(Boolean)) {
      initialQueryPending.current = false;
    }
    if (subject === "people" || subject === "hardware") setSubjectTypeFilter(subject);
    if (result === "approved" || result === "denied") setStatusFilter(result);
    if (scanType === "auto" || scanType === "manual") setScanTypeFilter(scanType);
    if (direction === "entry" || direction === "exit") setDirectionFilter(direction);
    if (reason) setSearch(reason);
    setFiltersReady(true);
  }, []);

  const rangeBounds = useMemo(() => {
    const preset = compactRangeBounds(timeRange);
    const rangeStart = startDate ? parseDateInput(startDate) ?? preset.start : preset.start;
    const rangeEnd = endDate ? parseDateInput(endDate, true) ?? preset.end : preset.end;
    return { rangeStart, rangeEnd };
  }, [endDate, startDate, timeRange]);

  useEffect(() => {
    setPage(1);
  }, [
    checkpointFilter,
    deferredSearch,
    directionFilter,
    endDate,
    scanTypeFilter,
    startDate,
    statusFilter,
    subjectTypeFilter,
    timeRange,
  ]);

  useEffect(() => {
    if (!filtersReady) return;
    if (initialQueryPending.current) {
      initialQueryPending.current = false;
      return;
    }
    let cancelled = false;
    setIsQuerying(true);
    setQueryError("");
    void queryMovements({
      page,
      pageSize: rowsPerPage,
      search: deferredSearch.trim() || undefined,
      checkpoint:
        checkpointFilter === "all" ? undefined : checkpointFilter,
      result: statusFilter === "all" ? undefined : statusFilter,
      scanType: scanTypeFilter === "all" ? undefined : scanTypeFilter,
      direction: directionFilter === "all" ? undefined : directionFilter,
      subjectGroup: subjectTypeFilter,
      startAt: new Date(rangeBounds.rangeStart).toISOString(),
      endAt: new Date(rangeBounds.rangeEnd).toISOString(),
      sortKey,
      sortDirection,
    })
      .then((result) => {
        if (cancelled) return;
        setMovementPage(result);
        setSelectedEventId((current) =>
          result.items.some((event) => event.id === current) ? current : ""
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setQueryError(
            error instanceof Error
              ? error.message
              : "Unable to update movement results."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsQuerying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    checkpointFilter,
    deferredSearch,
    directionFilter,
    filtersReady,
    page,
    queryMovements,
    rangeBounds.rangeEnd,
    rangeBounds.rangeStart,
    scanTypeFilter,
    sortDirection,
    sortKey,
    statusFilter,
    subjectTypeFilter,
  ]);

  function updateSort(column: VisibleColumn) {
    setSortKey(column);
    setSortDirection((current) => (sortKey === column && current === "asc" ? "desc" : "asc"));
  }

  function handleSaveNote(eventId: string) {
    const trimmed = drawerDraft.trim();
    if (!trimmed) return;
    void addMovementNote(eventId, trimmed).then((notes) => {
      setMovementPage((current) => ({
        ...current,
        movementNotes: {
          ...current.movementNotes,
          [eventId]: notes,
        },
      }));
    });
    setDrawerDraft("");
  }

  const selectedEvent = useMemo(
    () => movementPage.items.find((event) => event.id === selectedEventId),
    [movementPage.items, selectedEventId]
  );
  const selectedAlert = useMemo(
    () => alerts.find((alert) => alert.id === selectedEventId || alert.sourceEventId === selectedEventId),
    [alerts, selectedEventId]
  );
  const totalPages = Math.max(
    1,
    Math.ceil(movementPage.total / rowsPerPage)
  );

  return (
    <AdminPageFrame
      title="Movement Ledger"
      description="Search every entry, exit, denial, and offline movement with row-level review for security handoff."
      headerRight={<TrendChart events={movementPage.chartItems} timeRange={timeRange} onTimeRangeChange={setTimeRange} />}
      preTitle={
        <div className="pill-segmented-group">
          <button
            className={`pill-segmented-button ${subjectTypeFilter === "people" ? "active" : ""}`}
            onClick={() => setSubjectTypeFilter("people")}
          >
            People
          </button>
          <button
            className={`pill-segmented-button ${subjectTypeFilter === "hardware" ? "active" : ""}`}
            onClick={() => setSubjectTypeFilter("hardware")}
          >
            Hardware
          </button>
        </div>
      }
    >
    <section className={`split-workspace log-workspace${selectedEvent ? " has-detail-drawer" : ""}`}>
      <div className="workspace-main">

        <div className="filter-bar">
          <ReportBuilder movements={movementPage.chartItems} alerts={alerts} auditEvents={auditEvents} />
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
          <CalendarDatePicker 
            startDate={startDate} 
            endDate={endDate} 
            onRangeChange={(s, e) => { setStartDate(s); setEndDate(e); }}
          />
          <label className="select-control">
            <span className="sr-only">Filter by checkpoint</span>
            <select
              value={checkpointFilter}
              onChange={(e) => setCheckpointFilter(e.target.value)}
            >
              <option value="all">All Checkpoints</option>
              {movementPage.checkpoints.map(cp => <option key={cp} value={cp}>{cp}</option>)}
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
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by scan type</span>
            <select
              value={scanTypeFilter}
              onChange={(event) => setScanTypeFilter(event.target.value as typeof scanTypeFilter)}
            >
              <option value="all">All Scan Types</option>
              <option value="auto">Automatic</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by direction</span>
            <select
              value={directionFilter}
              onChange={(event) => setDirectionFilter(event.target.value as typeof directionFilter)}
            >
              <option value="all">All Directions</option>
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
          events={movementPage.items}
          selectedId={selectedEventId}
          visibleColumns={defaultVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="compact"
          onSort={updateSort}
          onSelect={setSelectedEventId}
        />
        <span className="sr-only" role="status" aria-live="polite">
          {queryError ||
          (isQuerying
            ? "Updating movement results."
            : `${movementPage.total} movement results loaded.`)}
        </span>
        
        <div className="pagination">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            type="button"
            disabled={page >= totalPages}
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
          notes={movementPage.movementNotes[selectedEvent.id] ?? []}
          noteDraft={drawerDraft}
          onNoteDraftChange={setDrawerDraft}
          onAddNote={() => handleSaveNote(selectedEvent.id)}
          onAcknowledge={() => {
            if (selectedAlert) void updateAlert(selectedAlert.id, { status: "acknowledged" });
          }}
          onResolve={() => {
            if (selectedAlert) void updateAlert(selectedAlert.id, { status: "resolved" });
          }}
          onClose={() => setSelectedEventId("")}
        />
      ) : null}
    </section>
    </AdminPageFrame>
  );
}
