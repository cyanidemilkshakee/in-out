"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Download } from "lucide-react";
import type {
  AlertPage,
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

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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
  const [subjectTypeFilter, setSubjectTypeFilter] = useState<"people" | "hardware">("people");
  const [page, setPage] = useState(1);
  const rowsPerPage = 25;
  const [sortKey, setSortKey] = useState<VisibleColumn>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [timeRange, setTimeRange] = useState<TimeRange>("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const deferredSearch = useDeferredValue(search);
  const searchTerm = deferredSearch.trim();
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
  const initialQueryPending = useRef(Boolean(initialMovementPage));
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: LogsTab = requestedTab === "permissions" || requestedTab === "alerts" ? requestedTab : "movements";
  const subjectId = searchParams.get("subject") || undefined;
  const [alertHistoryPage, setAlertHistoryPage] = useState<AlertPage>({ items: [], total: 0, limit: 50, offset: 0 });
  const acknowledgedRequests = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return permissionRequests
      .filter((request) => request.status !== "pending" && Boolean(request.notificationDismissedAt))
      .filter((request) => !needle || [request.subjectName, request.barcode,
        request.type.replaceAll("_", " "), request.status, request.checkpoint, request.operatorNote,
        request.decisionReason]
        .some((value) => value?.toLowerCase().includes(needle)))
      .sort((left, right) => (right.notificationDismissedAt ?? "").localeCompare(left.notificationDismissedAt ?? ""));
  }, [permissionRequests, deferredSearch]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const subject = params.get("subject");
    const result = params.get("result");
    const scanType = params.get("scanType");
    const direction = params.get("direction");
    const reason = params.get("reason");
    const eventId = params.get("eventId")?.trim();
    if ([subject, result, scanType, direction, reason, eventId].some(Boolean)) {
      initialQueryPending.current = false;
    }
    if (subject === "people" || subject === "hardware") setSubjectTypeFilter(subject);
    if (result === "approved" || result === "denied") setStatusFilter(result);
    if (scanType === "auto" || scanType === "manual") setScanTypeFilter(scanType);
    if (direction === "entry" || direction === "exit") setDirectionFilter(direction);
    if (reason) setSearch(reason);
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
    const receiveMovement = (event: Event) => {
      try {
        const update = JSON.parse((event as CustomEvent<string>).detail);
        if (update?.type === "manual_review_decision") {
          setQueryRevision(current => current + 1);
        }
      } catch {
        // Ignore malformed stream events; reconnect reloads the ledger.
      }
    };
    const reloadLedger = () => setQueryRevision(current => current + 1);
    window.addEventListener("inout:presence-message", receiveMovement);
    window.addEventListener("inout:presence-reconnected", reloadLedger);
    return () => {
      window.removeEventListener("inout:presence-message", receiveMovement);
      window.removeEventListener("inout:presence-reconnected", reloadLedger);
    };
  }, []);

  const rangeBounds = useMemo(() => {
    const preset = timeRange === "ALL"
      ? { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY }
      : compactRangeBounds(timeRange);
    const rangeStart = startDate ? parseDateInput(startDate) ?? preset.start : preset.start;
    const rangeEnd = timeRange === "ALL" && !startDate && !endDate
      ? preset.end
      : Math.min(endDate ? parseDateInput(endDate, true) ?? preset.end : preset.end, Date.now());
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
    const rangeQuery = {
      ...(Number.isFinite(rangeBounds.rangeStart)
        ? { startAt: new Date(rangeBounds.rangeStart).toISOString() }
        : {}),
      ...(Number.isFinite(rangeBounds.rangeEnd)
        ? { endAt: new Date(rangeBounds.rangeEnd).toISOString() }
        : {}),
    };
    void queryMovements({
      page: eventIdLookup ? 1 : page,
      pageSize: rowsPerPage,
      eventId: eventIdLookup,
      search: deferredSearch.trim() || undefined,
      checkpoint:
        checkpointFilter === "all" ? undefined : checkpointFilter,
      result: statusFilter === "all" ? undefined : statusFilter,
      scanType: scanTypeFilter === "all" ? undefined : scanTypeFilter,
      direction: directionFilter === "all" ? undefined : directionFilter,
      subjectGroup: subjectTypeFilter,
      ...rangeQuery,
      sortKey,
      sortDirection,
    })
      .then((result) => {
        if (cancelled) return;
        setMovementPage(result);
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
    eventIdLookup,
    filtersReady,
    page,
    queryMovements,
    queryRevision,
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

  const totalPages = Math.max(
    1,
    Math.ceil(movementPage.total / rowsPerPage)
  );
  function exportHistory() {
    const rows: Array<Record<string, unknown>> = activeTab === "permissions"
      ? acknowledgedRequests.map((request) => ({
          requestType: request.type,
          subject: request.subjectName,
          barcode: request.barcode,
          checkpoint: request.checkpoint,
          decision: request.status,
          decidedAt: request.decidedAt,
          operatorNote: request.operatorNote,
          decisionNote: request.decisionReason,
        }))
      : alertHistoryPage.items.map((alert) => ({
          alertId: alert.id,
          alert: alert.title,
          subject: alert.subjectName,
          barcode: alert.barcode,
          severity: alert.severity,
          triggeredAt: alert.createdAt,
          checkpoint: alert.checkpoint,
          reason: alert.reason,
          status: alert.status,
          decision: alert.review?.decision,
          reviewedAt: alert.review?.reviewedAt,
          reviewedBy: alert.review?.reviewedBy,
          reviewNote: alert.review?.reason,
          warningResetAt: alert.warningResetAt,
          warningResetBy: alert.warningResetBy,
          warningResetReason: alert.warningResetReason,
        }));
    downloadCsv(`inout-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

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
          <ReportBuilder movements={movementPage.chartItems} alerts={alerts} auditEvents={auditEvents} />
          <LogTimeRangeDropdown
            range={timeRange}
            startDate={startDate}
            endDate={endDate}
            onRangeChange={(value) => { setTimeRange(value); setPage(1); }}
            onDateRangeChange={(start, end) => { setStartDate(start); setEndDate(end); setPage(1); }}
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
            <button className="admin-button admin-button--ghost ghost-button" type="button" onClick={exportHistory} disabled={!acknowledgedRequests.length}>
              <Download />Export
            </button>
            <label className="search-control registry-search-control">
              <span className="sr-only">Search acknowledged permission requests</span>
              <input type="search" maxLength={200} placeholder="Search permissions..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <AcknowledgedPermissionRequestsTable permissions={acknowledgedRequests} people={people} />
        </div>
      </section>
    ) : (
      <section className="registry-workspace">
        <div className="admin-panel workspace-main">
          <div className="filter-bar">
            <button className="admin-button admin-button--ghost ghost-button" type="button" onClick={exportHistory} disabled={!alertHistoryPage.items.length}>
              <Download />Export page
            </button>
            <label className="search-control registry-search-control">
              <span className="sr-only">Search alert history</span>
              <input type="search" maxLength={200} placeholder="Search alerts..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <AlertsHistoryTable search={deferredSearch} subjectId={subjectId} people={people} onLoad={setAlertHistoryPage} />
        </div>
      </section>
    )}
    </AdminPageFrame>
  );
}

export default function LogsPage() {
  return <Suspense fallback={<p role="status">Loading logs…</p>}><LogsWorkspace /></Suspense>;
}
