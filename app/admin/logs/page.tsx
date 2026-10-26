"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import type {
  AlertPage,
  MovementQuery,
  MovementPage,
  VisibleColumn,
  SortDirection,
  ResultStatus,
} from "../../../lib/types";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { MovementTable } from "../../../frontend/components/admin/tables/MovementTable";
import { CalendarDatePicker } from "../../../frontend/components/analytics/CalendarDatePicker";
import { AcknowledgedPermissionRequestsTable } from "../../../frontend/components/admin/permissions/AcknowledgedPermissionRequestsTable";
import { AlertsHistoryTable } from "../../../frontend/components/admin/alerts/AlertsHistoryTable";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import { isMovementEventId } from "../../../lib/movementReferences";
import { movementAnalyticsFilters } from "../../../lib/analyticsQueries";
import { normalizeCheckpointLabel } from "../../../lib/normalizeDashboard";
import {
  compactRangeBounds,
  parseDateInput,
} from "../../../lib/dateRanges";

const ReportBuilder = dynamic(
  () =>
    import("../../../frontend/components/admin/reports/ReportBuilder").then(
      (module) => module.ReportBuilder
    ),
  { ssr: false }
);
type StatusFilter = ResultStatus | "all";
type LogsTab = "movements" | "permissions" | "alerts";
type TimeRange = "ALL" | "1D" | "1W" | "1M" | "1Y";

const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "ALL", label: "All Time" },
  { value: "1Y", label: "Last 1 Year" },
  { value: "1M", label: "Last 1 Month" },
  { value: "1W", label: "Last 1 Week" },
  { value: "1D", label: "Last 24 Hours" },
];

function LogTimeRangeDropdown({
  range,
  startDate,
  endDate,
  onRangeChange,
  onDateRangeChange,
}: {
  range: TimeRange;
  startDate: string;
  endDate: string;
  onRangeChange: (range: TimeRange) => void;
  onDateRangeChange: (start: string, end: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasDateRange = Boolean(startDate || endDate);
  const rangeLabel = hasDateRange
    ? startDate && endDate
      ? `${startDate} – ${endDate}`
      : startDate
        ? `From ${startDate}`
        : `Until ${endDate}`
    : TIME_RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "Last 24 Hours";

  useEffect(() => {
    if (!isOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function selectRange(nextRange: TimeRange) {
    onRangeChange(nextRange);
    onDateRangeChange("", "");
    setIsOpen(false);
  }

  return (
    <div className="log-time-range-dropdown" ref={containerRef}>
      <button
        type="button"
        className="log-time-range-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="logs-time-range-menu"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span>{rangeLabel}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {isOpen && (
        <div id="logs-time-range-menu" className="log-time-range-menu" role="dialog" aria-label="Time range">
          <div className="log-time-range-options" role="group" aria-label="Quick ranges">
            {TIME_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={!hasDateRange && range === option.value}
                onClick={() => selectRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <CalendarDatePicker
            variant="inline"
            startDate={startDate}
            endDate={endDate}
            onRangeChange={(start, end) => {
              onDateRangeChange(start, end);
              setIsOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

const defaultVisibleColumns: Record<VisibleColumn, boolean> = {
  date: true,
  time: true,
  createdAt: false,
  name: true,
  active: true,
  type: true,
  direction: true,
  checkpoint: true,
  result: true,
  barcode: true,
  scanType: true,
  eventId: false
};

function updateEventUrl(eventId?: string) {
  const url = new URL(window.location.href);
  if (eventId) url.searchParams.set("eventId", eventId);
  else url.searchParams.delete("eventId");
  window.history.replaceState(window.history.state, "", url);
}

function LogsWorkspace() {
  const {
    people,
    movements: initialEvents,
    movementPage: initialMovementPage,
    alerts,
    auditEvents,
    movementNotes: initialEventNotes,
    permissionRequests,
  } = useDataState();
  const { queryMovements } = useDataActions();
  const [queryRevision, setQueryRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [linkedEventId, setLinkedEventId] = useState("");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [scanTypeFilter, setScanTypeFilter] = useState<"all" | "auto" | "manual">("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | "entry" | "exit">("all");
  const [denialCategory, setDenialCategory] = useState<MovementQuery["denialCategory"]>();
  const [subjectTypeFilter, setSubjectTypeFilter] = useState<"people" | "hardware">("people");
  const [page, setPage] = useState(1);
  const rowsPerPage = 25;
  const [sortKey, setSortKey] = useState<VisibleColumn>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [timeRange, setTimeRange] = useState<TimeRange>("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [linkedRange, setLinkedRange] = useState<{ startAt?: string; endAt?: string } | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const searchTerm = debouncedSearch.trim();
  const eventIdLookup = (linkedEventId && searchTerm === linkedEventId) || isMovementEventId(searchTerm)
    ? searchTerm : undefined;
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
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: LogsTab = requestedTab === "permissions" || requestedTab === "alerts" ? requestedTab : "movements";
  const initialQueryPending = useRef(Boolean(initialMovementPage) && activeTab === "movements");
  const lastChartQuery = useRef<string | null>(null);
  const subjectId = searchParams.get("subject") || undefined;
  const { startAt: alertStartAt, endAt: alertEndAt } = movementAnalyticsFilters(new URLSearchParams(searchParams.toString()));
  const [alertHistoryPage, setAlertHistoryPage] = useState<AlertPage>({ items: [], total: 0, limit: 50, offset: 0 });
  const acknowledgedRequests = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    return permissionRequests
      .filter((request) => request.status !== "pending" && Boolean(request.notificationDismissedAt))
      .filter((request) => !needle || [request.subjectName, request.barcode,
        request.type.replaceAll("_", " "), request.status, request.checkpoint, request.operatorNote,
        request.decisionReason]
        .some((value) => value?.toLowerCase().includes(needle)))
      .sort((left, right) => (right.notificationDismissedAt ?? "").localeCompare(left.notificationDismissedAt ?? ""));
  }, [permissionRequests, debouncedSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const subject = params.get("subject");
    const result = params.get("result");
    const scanType = params.get("scanType");
    const direction = params.get("direction");
    const reason = params.get("reason");
    const eventId = params.get("eventId")?.trim();
    const analyticsFilters = movementAnalyticsFilters(params);
    if ([subject, result, scanType, direction, reason, eventId, analyticsFilters.denialCategory,
      analyticsFilters.startAt, analyticsFilters.endAt].some(Boolean)) {
      initialQueryPending.current = false;
    }
    if (subject === "people" || subject === "hardware") setSubjectTypeFilter(subject);
    if (result === "approved" || result === "denied") setStatusFilter(result);
    if (scanType === "auto" || scanType === "manual") setScanTypeFilter(scanType);
    if (direction === "entry" || direction === "exit") setDirectionFilter(direction);
    if (reason) setSearch(reason);
    setDenialCategory(analyticsFilters.denialCategory);
    if (analyticsFilters.startAt || analyticsFilters.endAt) {
      setLinkedRange({ startAt: analyticsFilters.startAt, endAt: analyticsFilters.endAt });
      const facilityDate = (value?: string) => value ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(value)) : "";
      setStartDate(facilityDate(analyticsFilters.startAt));
      setEndDate(facilityDate(analyticsFilters.endAt));
    }
    if (eventId) {
      setLinkedEventId(eventId);
      setSearch(eventId);
    }
    setFiltersReady(true);
  }, []);

  useEffect(() => {
    if (filtersReady && activeTab === "movements") updateEventUrl(eventIdLookup || undefined);
  }, [activeTab, eventIdLookup, filtersReady]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadLedger = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        setQueryRevision(current => current + 1);
      }, 250);
    };
    const receiveMovement = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        if (update?.movement || update?.type === "manual_review_decision" || update?.type === "data_changed") {
          reloadLedger();
        }
      } catch {
        // Ignore malformed stream events; reconnect reloads the ledger.
      }
    };
    window.addEventListener("inout:presence-message", receiveMovement);
    window.addEventListener("inout:presence-sync", reloadLedger);
    return () => {
      clearTimeout(refreshTimer);
      window.removeEventListener("inout:presence-message", receiveMovement);
      window.removeEventListener("inout:presence-sync", reloadLedger);
    };
  }, []);

  const rangeBounds = useMemo(() => {
    if (linkedRange) return {
      rangeStart: linkedRange.startAt ? Date.parse(linkedRange.startAt) : Number.NEGATIVE_INFINITY,
      rangeEnd: linkedRange.endAt ? Date.parse(linkedRange.endAt) : Number.POSITIVE_INFINITY,
    };
    const preset = timeRange === "ALL"
      ? { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY }
      : compactRangeBounds(timeRange);
    const rangeStart = startDate ? parseDateInput(startDate) ?? preset.start : preset.start;
    const rangeEnd = timeRange === "ALL" && !startDate && !endDate
      ? preset.end
      : Math.min(endDate ? parseDateInput(endDate, true) ?? preset.end : preset.end, Date.now());
    return { rangeStart, rangeEnd };
  }, [endDate, startDate, timeRange, linkedRange]);

  useEffect(() => {
    setPage(1);
  }, [
    checkpointFilter,
    debouncedSearch,
    directionFilter,
    denialCategory,
    endDate,
    scanTypeFilter,
    startDate,
    statusFilter,
    subjectTypeFilter,
    timeRange,
  ]);

  useEffect(() => {
    if (!filtersReady || activeTab !== "movements" || search !== debouncedSearch) return;
    const rangeQuery = {
      ...(Number.isFinite(rangeBounds.rangeStart)
        ? { startAt: new Date(rangeBounds.rangeStart).toISOString() }
        : {}),
      ...(Number.isFinite(rangeBounds.rangeEnd)
        ? { endAt: new Date(rangeBounds.rangeEnd).toISOString() }
        : {}),
    };
    const filters = {
      eventId: eventIdLookup,
      search: debouncedSearch.trim() || undefined,
      checkpoint:
        checkpointFilter === "all" ? undefined : checkpointFilter,
      result: statusFilter === "all" ? undefined : statusFilter,
      scanType: scanTypeFilter === "all" ? undefined : scanTypeFilter,
      direction: directionFilter === "all" ? undefined : directionFilter,
      denialCategory,
      subjectGroup: subjectTypeFilter,
      ...rangeQuery,
    };
    // Row ordering and pagination do not change the report/chart population.
    // Stream invalidations do, even when the visible filters stay the same.
    const chartQuery = JSON.stringify([filters, queryRevision]);
    if (initialQueryPending.current) {
      initialQueryPending.current = false;
      lastChartQuery.current = chartQuery;
      return;
    }
    const includeChart = lastChartQuery.current !== chartQuery;
    const controller = new AbortController();
    setIsQuerying(true);
    setQueryError("");
    void queryMovements({
      ...filters,
      page: eventIdLookup ? 1 : page,
      pageSize: rowsPerPage,
      sortKey,
      sortDirection,
      includeChart,
    }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (includeChart) lastChartQuery.current = chartQuery;
        setMovementPage(current => includeChart ? result : {
          ...result,
          chartItems: current.chartItems,
          checkpoints: current.checkpoints,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setQueryError(
            error instanceof Error
              ? error.message
              : "Unable to update movement results."
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsQuerying(false);
      });
    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    checkpointFilter,
    debouncedSearch,
    directionFilter,
    denialCategory,
    eventIdLookup,
    filtersReady,
    page,
    queryMovements,
    queryRevision,
    rangeBounds.rangeEnd,
    rangeBounds.rangeStart,
    scanTypeFilter,
    search,
    sortDirection,
    sortKey,
    statusFilter,
    subjectTypeFilter,
  ]);

  function updateSort(column: VisibleColumn) {
    setSortKey(column);
    setSortDirection((current) => (sortKey === column && current === "asc" ? "desc" : "asc"));
  }

  const totalPages = Math.max(
    1,
    Math.ceil(movementPage.total / rowsPerPage)
  );
  return (
    <AdminPageFrame
      title={activeTab === "movements" ? "Movement Logs" : activeTab === "permissions" ? "Permission Logs" : "Alert Logs"}
      metric={activeTab === "permissions" ? `${acknowledgedRequests.length} acknowledged requests` : activeTab === "alerts" ? `${alertHistoryPage.total} alerts` : undefined}
      preTitle={
        <>
          <nav className="registry-segmented-shell" aria-label="Log categories">
            <div className="pill-segmented-group registry-segmented-group">
              <Link href="/admin/logs" className={`pill-segmented-button ${activeTab === "movements" ? "active" : ""}`} aria-current={activeTab === "movements" ? "page" : undefined}>Movements</Link>
              <Link href="/admin/logs?tab=permissions" className={`pill-segmented-button ${activeTab === "permissions" ? "active" : ""}`} aria-current={activeTab === "permissions" ? "page" : undefined}>Permissions</Link>
              <Link href={subjectId ? `/admin/logs?tab=alerts&subject=${encodeURIComponent(subjectId)}` : "/admin/logs?tab=alerts"} className={`pill-segmented-button ${activeTab === "alerts" ? "active" : ""}`} aria-current={activeTab === "alerts" ? "page" : undefined}>Alerts</Link>
            </div>
          </nav>
          {activeTab === "movements" ? <div className="pill-segmented-group">
            <button
              className={`pill-segmented-button ${subjectTypeFilter === "people" ? "active" : ""}`}
              type="button"
              onClick={() => setSubjectTypeFilter("people")}
            >People</button>
            <button
              className={`pill-segmented-button ${subjectTypeFilter === "hardware" ? "active" : ""}`}
              type="button"
              onClick={() => setSubjectTypeFilter("hardware")}
            >Hardware</button>
          </div> : null}
        </>
      }
    >
    {activeTab === "movements" ? (
    <section className="split-workspace log-workspace">
      <div className="admin-panel workspace-main">

        <div className="filter-bar">
          <ReportBuilder movements={movementPage.chartItems} alerts={alerts} auditEvents={auditEvents} activeSource="movements" checkpoints={movementPage.checkpoints} />
          <LogTimeRangeDropdown
            range={timeRange}
            startDate={startDate}
            endDate={endDate}
            onRangeChange={(value) => { setLinkedRange(null); setTimeRange(value); setPage(1); }}
            onDateRangeChange={(start, end) => { setLinkedRange(null); setStartDate(start); setEndDate(end); setPage(1); }}
          />
          <label className="select-control">
            <span className="sr-only">Filter by checkpoint</span>
            <select
              value={checkpointFilter}
              onChange={(e) => setCheckpointFilter(e.target.value)}
            >
              <option value="all">All Checkpoints</option>
              {movementPage.checkpoints.map((checkpoint) => {
                const label = normalizeCheckpointLabel(checkpoint);
                return label ? <option key={label} value={label}>{label}</option> : null;
              })}
            </select>
          </label>
          <label className="select-control">
            <span className="sr-only">Filter by denial category</span>
            <select value={denialCategory ?? "all"} onChange={event => setDenialCategory(
              event.target.value === "all" ? undefined : event.target.value as MovementQuery["denialCategory"])}>
              <option value="all">All denial reasons</option>
              <option value="restricted">Restricted</option>
              <option value="other">Other</option>
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
          <label className="search-control">
            <span className="sr-only">Search events</span>
            <input
              type="search"
              placeholder="Search event IDs, subjects, barcodes, reasons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>

        {eventIdLookup ? (
          <p className="inline-note" role="status">
            Looking up this event ID across all dates, checkpoints, and subject types. Clear the search to use the filters again.
          </p>
        ) : null}
        {queryError ? <p className="inline-note" role="alert">{queryError}</p> : null}
        <MovementTable
          events={movementPage.items}
          people={people}
          visibleColumns={defaultVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="compact"
          layout="logs"
          onSort={updateSort}
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

    </section>
    ) : activeTab === "permissions" ? (
      <section className="registry-workspace">
        <div className="admin-panel workspace-main">
          <div className="filter-bar">
            <ReportBuilder movements={movementPage.chartItems} alerts={alerts} auditEvents={auditEvents} activeSource="permissions" checkpoints={movementPage.checkpoints} />
            <label className="search-control registry-search-control">
              <span className="sr-only">Search acknowledged permission requests</span>
              <input type="search" maxLength={200} placeholder="Search permissions..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <AcknowledgedPermissionRequestsTable permissions={acknowledgedRequests} people={people} />
        </div>
      </section>
    ) : (
      <section className="split-workspace log-workspace">
        <div className="admin-panel workspace-main">
          <div className="filter-bar">
            <ReportBuilder movements={movementPage.chartItems} alerts={alerts} auditEvents={auditEvents} activeSource="alerts" checkpoints={movementPage.checkpoints} />
            <label className="search-control">
              <span className="sr-only">Search alert history</span>
              <input type="search" maxLength={200} placeholder="Search alerts..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <AlertsHistoryTable search={debouncedSearch} subjectId={subjectId} startAt={alertStartAt} endAt={alertEndAt} people={people} onLoad={setAlertHistoryPage} />
        </div>
      </section>
    )}
    </AdminPageFrame>
  );
}

export default function LogsPage() {
  return <Suspense fallback={<p role="status">Loading logs…</p>}><LogsWorkspace /></Suspense>;
}
