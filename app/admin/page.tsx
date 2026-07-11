"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Bell,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Filter,
  Grid2X2,
  History,
  Heart,
  MapPin,
  Package,
  RefreshCw,
  ScanBarcode,
  Search,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  X
} from "lucide-react";
import { AppChrome } from "../../components/AppChrome";
import { DashboardCharts } from "../../components/analytics/DashboardCharts";
import { ResultPill, ScannerPill, SyncPill } from "../../components/StatusPill";
import { ToastRegion, type ToastMessage } from "../../components/ToastRegion";
import {
  checkpoints,
  hardwareAssets,
  initialAlerts,
  initialMovements,
  people,
  scanAnalytics,
  scanners
} from "../../lib/mockData";
import type {
  Alert,
  HardwareAsset,
  MovementEvent,
  Person,
  ResultStatus,
  ScanAnalytics,
  Scanner
} from "../../lib/types";

const adminViews = [
  "Dashboard",
  "Logs",
  "Alerts",
  "Employees",
  "Visitors",
  "Hardware",
  "Barcodes",
  "Checkpoints",
  "Scanners",
  "Offline Sync"
] as const;

type AdminView = (typeof adminViews)[number];

type StatusFilter = ResultStatus | "all" | "exceptions" | "queued";
type SortDirection = "asc" | "desc";


const adminViewSlugs: Record<AdminView, string> = {
  Dashboard: "",
  Logs: "logs",
  Alerts: "alerts",
  Employees: "employees",
  Visitors: "visitors",
  Hardware: "hardware",
  Barcodes: "barcodes",
  Checkpoints: "checkpoints",
  Scanners: "scanners",
  "Offline Sync": "offline-sync"
};

const slugToAdminView = Object.fromEntries(
  Object.entries(adminViewSlugs).map(([view, slug]) => [slug, view])
) as Record<string, AdminView>;

function getAdminPath(view: AdminView) {
  const slug = adminViewSlugs[view];
  return slug ? `/admin/${slug}` : "/admin";
}

function viewFromPathname(pathname: string): AdminView {
  const [, first, second] = pathname.split("/");
  if (first !== "admin") {
    return "Dashboard";
  }
  return slugToAdminView[second ?? ""] ?? "Dashboard";
}

function formatTodayLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatClock(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

const adminRailGroups = [
  {
    label: "Operations",
    items: [
      { view: "Dashboard" as AdminView, icon: Grid2X2, label: "Dashboard" },
      { view: "Logs" as AdminView, icon: History, label: "Movement Logs" },
      { view: "Alerts" as AdminView, icon: Bell, label: "Alerts" }
    ]
  },
  {
    label: "Types & Forms",
    items: [
      { view: "Employees" as AdminView, icon: UsersRound, label: "Employees" },
      { view: "Visitors" as AdminView, icon: UserRound, label: "Visitors" },
      { view: "Hardware" as AdminView, icon: Package, label: "Hardware" },
      { view: "Barcodes" as AdminView, icon: ScanBarcode, label: "Barcodes" }
    ]
  }
];

type VisibleColumn =
  | "time"
  | "checkpoint"
  | "direction"
  | "subject"
  | "type"
  | "barcode"
  | "result"
  | "reason"
  | "scanner"
  | "sync";

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

export default function AdminPage() {
  const router = useRouter();
  const pathname = usePathname();
  const todayLabel = useMemo(() => formatTodayLabel(new Date()), []);
  const [activeView, setActiveView] = useState<AdminView>(() => viewFromPathname(pathname));
  const [events, setEvents] = useState<MovementEvent[]>(initialMovements);
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [staff, setStaff] = useState<Person[]>(people);
  const [assets, setAssets] = useState<HardwareAsset[]>(hardwareAssets);
  const [scannerState, setScannerState] = useState<Scanner[]>(scanners);
  const [selectedEventId, setSelectedEventId] = useState(initialMovements[0]?.id ?? "");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("today");
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [page, setPage] = useState(1);
  const [showColumns, setShowColumns] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(defaultVisibleColumns);
  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [tableDensity, setTableDensity] = useState<"comfortable" | "compact">("comfortable");
  const [eventNotes, setEventNotes] = useState<Record<string, string[]>>({});
  const [drawerDraft, setDrawerDraft] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => new Date());
  const [refreshLabel, setRefreshLabel] = useState("Live");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setActiveView(viewFromPathname(pathname));
    setPage(1);
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const linkedEventId = params.get("event");
    if (linkedEventId && events.some((event) => event.id === linkedEventId)) {
      setSelectedEventId(linkedEventId);
    }
  }, [events, pathname]);

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
      const aValue = valueFor(a, sortKey);
      const bValue = valueFor(b, sortKey);
      const comparison =
        typeof aValue === "number" && typeof bValue === "number"
          ? aValue - bValue
          : String(aValue).localeCompare(String(bValue));
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredEvents, sortDirection, sortKey]);

  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? sortedEvents[0] ?? events[0];
  const selectedAlert = alerts.find(
    (alert) =>
      alert.barcode === selectedEvent?.barcode &&
      alert.status !== "resolved" &&
      selectedEvent.result !== "success"
  );
  const totalPages = Math.max(1, Math.ceil(sortedEvents.length / rowsPerPage));
  const pagedEvents = sortedEvents.slice((page - 1) * rowsPerPage, page * rowsPerPage);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const metrics = useMemo(() => {
    const openAlerts = alerts.filter((alert) => alert.status !== "resolved").length;
    const queued = events.filter((event) => event.syncState !== "synced").length;
    const onlineScanners = scannerState.filter((scanner) => scanner.status === "online").length;
    const localExceptions = scannerState.filter((scanner) => scanner.status !== "online").length;
    return [
      {
        label: "Active Inside",
        value: scanAnalytics.activeInside.toLocaleString(),
        tone: "neutral"
      },
      {
        label: "Alerts",
        value: String(8 + Math.max(0, openAlerts - 3)),
        tone: "bad"
      },
      {
        label: "Offline Queue",
        value: String(queued),
        tone: "accent"
      },
      {
        label: "Scanner Status",
        value: `${onlineScanners}/${scannerState.length} Online`,
        tone: "good"
      }
    ];
  }, [alerts, events, scannerState]);



  function showToast(message: string, actionLabel?: string, onAction?: () => void) {
    setToast({ id: Date.now(), message, actionLabel, onAction });
  }

  function updateSelectedEventQuery(eventId?: string) {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (eventId) {
      params.set("event", eventId);
    } else {
      params.delete("event");
    }
    const query = params.toString();
    router.replace(`${getAdminPath(activeView)}${query ? `?${query}` : ""}`, { scroll: false });
  }

  function navigateToView(view: AdminView) {
    setActiveView(view);
    setPage(1);
    setShowColumns(false);
    router.push(getAdminPath(view));
  }

  function selectEvent(eventId: string) {
    setSelectedEventId(eventId);
    updateSelectedEventQuery(eventId);
  }

  function clearSelectedEvent() {
    setSelectedEventId("");
    updateSelectedEventQuery();
  }

  function updateAlertStatus(alertId: string, status: Alert["status"]) {
    const previous = alerts.find((alert) => alert.id === alertId);
    setAlerts((current) =>
      current.map((alert) => (alert.id === alertId ? { ...alert, status } : alert))
    );
    if (previous) {
      showToast(`${previous.id} marked ${status}.`, "Undo", () => {
        setAlerts((current) => current.map((alert) => (alert.id === alertId ? previous : alert)));
      });
    }
  }

  function bulkUpdateAlerts(alertIds: string[], status: Alert["status"]) {
    const previous = alerts;
    setAlerts((current) =>
      current.map((alert) => (alertIds.includes(alert.id) ? { ...alert, status } : alert))
    );
    showToast(`${alertIds.length} alert${alertIds.length === 1 ? "" : "s"} marked ${status}.`, "Undo", () => {
      setAlerts(previous);
    });
  }

  function togglePersonInside(personId: string) {
    const previous = staff;
    const person = staff.find((item) => item.id === personId);
    setStaff((current) =>
      current.map((item) =>
        item.id === personId ? { ...item, inside: !item.inside } : item
      )
    );
    if (person) {
      showToast(`${person.name} presence updated.`, "Undo", () => setStaff(previous));
    }
  }

  function toggleAssetInside(assetId: string) {
    const previous = assets;
    const asset = assets.find((item) => item.id === assetId);
    setAssets((current) =>
      current.map((item) => (item.id === assetId ? { ...item, inside: !item.inside } : item))
    );
    if (asset) {
      showToast(`${asset.name} presence updated.`, "Undo", () => setAssets(previous));
    }
  }

  function toggleScanner(scannerId: string) {
    const previous = scannerState;
    const scanner = scannerState.find((item) => item.id === scannerId);
    setScannerState((current) =>
      current.map((item) => {
        if (item.id !== scannerId) {
          return item;
        }
        return {
          ...item,
          status: item.status === "online" ? "offline" : "online",
          lastSeen: item.status === "online" ? item.lastSeen : "Just now"
        };
      })
    );
    if (scanner) {
      showToast(`${scanner.name} scanner status changed.`, "Undo", () => setScannerState(previous));
    }
  }

  function syncQueued(eventIds?: string[]) {
    const previous = events;
    const targetIds = eventIds?.length ? eventIds : events.filter((event) => event.syncState === "queued").map((event) => event.id);
    setEvents((current) =>
      current.map((event) =>
        targetIds.includes(event.id) && event.syncState === "queued"
          ? { ...event, syncState: event.result === "success" || event.result === "manual_review" ? "synced" : "conflict" }
          : event
      )
    );
    showToast(`${targetIds.length} queued event${targetIds.length === 1 ? "" : "s"} processed.`, "Undo", () => {
      setEvents(previous);
    });
  }

  function resolveSyncConflicts(eventIds: string[]) {
    const previous = events;
    setEvents((current) =>
      current.map((event) =>
        eventIds.includes(event.id)
          ? { ...event, syncState: "synced", reason: `${event.reason} / conflict reviewed` }
          : event
      )
    );
    showToast(`${eventIds.length} conflict${eventIds.length === 1 ? "" : "s"} resolved.`, "Undo", () => {
      setEvents(previous);
    });
  }

  function saveEventNote(eventId: string, note: string) {
    const trimmed = note.trim();
    if (!trimmed) {
      return;
    }
    setEventNotes((current) => ({
      ...current,
      [eventId]: [...(current[eventId] ?? []), trimmed]
    }));
    setDrawerDraft("");
    showToast(`Note saved for ${eventId}.`);
  }

  function refreshAdminData() {
    setRefreshLabel("Refreshing");
    setEvents((current) => [...current]);
    const updatedAt = new Date();
    setLastUpdatedAt(updatedAt);
    setRefreshLabel("Updated");
    showToast(`Data refreshed at ${formatClock(updatedAt)}.`);
  }

  function updateSort(column: VisibleColumn) {
    setSortKey(column);
    setSortDirection((current) => (sortKey === column && current === "asc" ? "desc" : "asc"));
  }

  function applyFilterPreset(preset: "all" | "exceptions" | "offline") {
    setCheckpointFilter("all");
    setSearch("");
    setDateFilter("today");
    setStatusFilter(preset === "all" ? "all" : preset === "exceptions" ? "exceptions" : "queued");
    setPage(1);
  }

  function clearFilters() {
    setCheckpointFilter("all");
    setStatusFilter("all");
    setSearch("");
    setDateFilter("today");
    setPage(1);
    showToast("Filters cleared.");
  }

  return (
    <AppChrome role="admin">
      <main className="admin-console" style={{ display: "flex", flexDirection: "row", height: "100vh", padding: 0 }}>

        {/* Sidebar Container - Always reserves exactly 72px in the page layout */}
        <div style={{ flexShrink: 0, width: "72px", position: "relative", zIndex: 50 }}>
          <aside
            onMouseEnter={() => setSidebarOpen(true)}
            onMouseLeave={() => setSidebarOpen(false)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: sidebarOpen ? "250px" : "72px",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
              padding: "0 12px",
              backgroundColor: "transparent",
              borderRight: "none",
              transition: "width 0.3s cubic-bezier(0.2, 0, 0, 1)",
            overflow: "hidden",
            whiteSpace: "nowrap"
          }}
          aria-label="Admin quick navigation"
        >
          {/* Logo - Top */}
          <div style={{
            position: "absolute",
            top: "16px",
            left: "12px",
            width: "calc(100% - 24px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            padding: "12px",
          }}>
            <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
              <Heart size={24} strokeWidth={2} />
            </div>
            <span style={{
              marginLeft: "20px",
              fontSize: "15px",
              fontWeight: 800,
              opacity: sidebarOpen ? 1 : 0,
              transition: "opacity 0.2s ease",
              pointerEvents: sidebarOpen ? "auto" : "none",
              color: "rgba(0,0,0,0.85)"
            }}>
              In/Out
            </span>
          </div>

          {/* Top Spacer */}
          <div style={{ flex: 1 }} />

          {/* Nav Icons */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
            {adminRailGroups.flatMap(group => group.items).map((item) => {
              const Icon = item.icon;
              const active = activeView === item.view;
              const isAlert = item.view === "Alerts";

              return (
                <button
                  key={item.label}
                  onClick={() => { navigateToView(item.view); setSidebarOpen(false); }}
                  title={sidebarOpen ? "" : item.label}
                  style={{
                    background: "none",
                    border: "none",
                    color: active ? "#000" : "rgba(0,0,0,0.65)",
                    cursor: "pointer",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    padding: "12px",
                    width: "100%",
                    borderRadius: "12px",
                    transition: "background-color 0.2s ease, transform 0.2s ease",
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.06)";
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                    <Icon size={24} strokeWidth={active ? 2 : 1.25} />
                    {isAlert && (
                      <span style={{
                        position: "absolute",
                        top: "8px",
                        left: "26px",
                        width: "10px",
                        height: "10px",
                        backgroundColor: "#ff3040",
                        borderRadius: "50%",
                        border: "2px solid var(--bg, #121212)"
                      }} />
                    )}
                  </div>
                  <span style={{
                    marginLeft: "20px",
                    fontSize: "15px",
                    fontWeight: active ? 700 : 400,
                    opacity: sidebarOpen ? 1 : 0,
                    transition: "opacity 0.2s ease",
                    pointerEvents: sidebarOpen ? "auto" : "none"
                  }}>
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Bottom Spacer */}
          <div style={{ flex: 1 }} />

          {/* User Profile - Bottom */}
          <button 
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              position: "absolute",
              bottom: "16px",
              left: "12px",
              width: "calc(100% - 24px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              padding: "12px",
              borderRadius: "12px",
              transition: "background-color 0.2s ease",
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.06)"}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            title="Profile"
          >
            <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
              <div style={{
                width: "24px",
                height: "24px",
                borderRadius: "50%",
                backgroundColor: "#ff7b00",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff"
              }}>
                <UserRound size={16} strokeWidth={2} />
              </div>
            </div>
            <span style={{
              marginLeft: "20px",
              fontSize: "15px",
              fontWeight: 400,
              opacity: sidebarOpen ? 1 : 0,
              transition: "opacity 0.2s ease",
              pointerEvents: sidebarOpen ? "auto" : "none",
              color: "rgba(0,0,0,0.65)"
            }}>
              Profile
            </span>
          </button>
          </aside>
        </div>

        <div style={{ flex: 1, position: "relative", width: "auto" }}>
          {activeView === "Dashboard" ? (
            <DashboardOverview
            alerts={alerts}
            metrics={metrics}
            scanAnalytics={scanAnalytics}
            scannerState={scannerState}
            events={events}
          />
        ) : null}

        {activeView === "Logs" ? (
          <section className="split-workspace">
            <div className="workspace-main">
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
                    <div className="column-menu">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => setShowColumns((value) => !value)}
                      >
                        <Columns3 />
                        Columns
                      </button>
                      {showColumns ? (
                        <div className="popover">
                          {(Object.keys(visibleColumns) as VisibleColumn[]).map((column) => (
                            <label key={column} className="checkbox-row">
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
                    <button className="icon-button" type="button" onClick={refreshAdminData} aria-label="Refresh movement data">
                      <RefreshCw />
                    </button>
                  </div>
                </div>
                <MovementTable
                  events={pagedEvents}
                  selectedId={selectedEvent?.id}
                  visibleColumns={visibleColumns}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  density={tableDensity}
                  onSort={updateSort}
                  onSelect={selectEvent}
                />
                <div className="table-footer">
                  <div className="pagination">
                    <button
                      className="icon-button"
                      disabled={page === 1}
                      type="button"
                      aria-label="Previous page"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft />
                    </button>
                    <span>
                      Page {page} / {totalPages}
                    </span>
                    <button
                      className="icon-button"
                      disabled={page === totalPages}
                      type="button"
                      aria-label="Next page"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      <ChevronRight />
                    </button>
                  </div>
                  <label className="rows-select">
                    Rows per page:
                    <select
                      value={rowsPerPage}
                      onChange={(event) => {
                        setRowsPerPage(Number(event.target.value));
                        setPage(1);
                      }}
                    >
                      <option value={10}>10</option>
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </label>
                </div>
              </div>
              {selectedEvent ? (
                <DetailDrawer
                  alert={selectedAlert}
                  event={selectedEvent}
                  notes={eventNotes[selectedEvent.id] ?? []}
                  noteDraft={drawerDraft}
                  onNoteDraftChange={setDrawerDraft}
                  onAcknowledge={() =>
                    selectedAlert ? updateAlertStatus(selectedAlert.id, "acknowledged") : null
                  }
                  onResolve={() => (selectedAlert ? updateAlertStatus(selectedAlert.id, "resolved") : null)}
                  onAddNote={() => saveEventNote(selectedEvent.id, drawerDraft)}
                  onClose={clearSelectedEvent}
                />
              ) : null}
          </section>
        ) : null}

        {activeView === "Alerts" ? (
          <AlertsView alerts={alerts} onUpdate={updateAlertStatus} onBulkUpdate={bulkUpdateAlerts} />
        ) : null}

        {activeView === "Employees" ? (
          <PeopleTable
            title="Employees"
            people={staff.filter((person) => person.type === "employee")}
            onToggleInside={togglePersonInside}
          />
        ) : null}

        {activeView === "Visitors" ? (
          <PeopleTable
            title="Visitors"
            people={staff.filter((person) => person.type === "visitor")}
            onToggleInside={togglePersonInside}
          />
        ) : null}

        {activeView === "Hardware" ? (
          <HardwareTable assets={assets} onToggleInside={toggleAssetInside} />
        ) : null}

        {activeView === "Barcodes" ? <BarcodeTable people={staff} assets={assets} /> : null}

        {activeView === "Checkpoints" ? (
          <CheckpointTable scannerState={scannerState} onToggleScanner={toggleScanner} />
        ) : null}

        {activeView === "Scanners" ? (
          <ScannerTable scannerState={scannerState} onToggleScanner={toggleScanner} />
        ) : null}

        {activeView === "Offline Sync" ? (
          <OfflineSyncTable events={events} onResolveConflicts={resolveSyncConflicts} onSync={syncQueued} />
        ) : null}
        <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
        </div>
      </main>
    </AppChrome>
  );
}

function DashboardOverview({
  alerts,
  metrics,
  scanAnalytics,
  scannerState,
  events
}: {
  alerts: Alert[];
  metrics: { label: string; value: string; tone: string }[];
  scanAnalytics: ScanAnalytics;
  scannerState: Scanner[];
  events: MovementEvent[];
}) {
  return (
    <section className="dashboard-overview" aria-label="Operational overview" style={{ margin: 0, padding: 0 }}>
      <DashboardCharts
        alerts={alerts}
        events={events}
        scanAnalytics={scanAnalytics}
        scanners={scannerState}
      />
    </section>
  );
}



function MovementTable({
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
      <th aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
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
            {visibleColumns.time ? sortHeader("time", "Time") : null}
            {visibleColumns.checkpoint ? sortHeader("checkpoint", "Checkpoint") : null}
            {visibleColumns.direction ? sortHeader("direction", "Direction") : null}
            {visibleColumns.subject ? sortHeader("subject", "Subject") : null}
            {visibleColumns.type ? sortHeader("type", "Type") : null}
            {visibleColumns.barcode ? sortHeader("barcode", "Barcode") : null}
            {visibleColumns.result ? sortHeader("result", "Result") : null}
            {visibleColumns.reason ? sortHeader("reason", "Reason") : null}
            {visibleColumns.scanner ? sortHeader("scanner", "Scanner") : null}
            {visibleColumns.sync ? sortHeader("sync", "Sync") : null}
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
            >
              {visibleColumns.time ? (
                <td>
                  <button
                    className="row-detail-button"
                    type="button"
                    onClick={() => onSelect(event.id)}
                    aria-label={`Open details for ${event.subjectName} at ${event.time}`}
                  >
                    {event.time}
                  </button>
                </td>
              ) : null}
              {visibleColumns.checkpoint ? <td>{event.checkpoint}</td> : null}
              {visibleColumns.direction ? (
                <td>
                  <span className={`direction direction-${event.direction}`}>{event.direction}</span>
                </td>
              ) : null}
              {visibleColumns.subject ? <td>{event.subjectName}</td> : null}
              {visibleColumns.type ? <td>{event.subjectType}</td> : null}
              {visibleColumns.barcode ? <td>{event.barcode}</td> : null}
              {visibleColumns.result ? (
                <td>
                  <ResultPill value={event.result} />
                </td>
              ) : null}
              {visibleColumns.reason ? <td>{event.reason}</td> : null}
              {visibleColumns.scanner ? <td>{event.scannerId}</td> : null}
              {visibleColumns.sync ? (
                <td>
                  <SyncPill value={event.syncState} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailDrawer({
  alert,
  event,
  notes,
  noteDraft,
  onNoteDraftChange,
  onAcknowledge,
  onResolve,
  onAddNote,
  onClose
}: {
  alert?: Alert;
  event: MovementEvent;
  notes: string[];
  noteDraft: string;
  onNoteDraftChange: (value: string) => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onAddNote: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="detail-drawer" aria-label="Movement details">
      <div className="drawer-header">
        <h2>{event.result === "success" ? "Movement Details" : "Alert Details"}</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close movement details">
          <X />
        </button>
      </div>
      <div className="drawer-id">
        <ResultPill value={event.result} />
        <strong>{alert?.id ?? event.id}</strong>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Reason</dt>
          <dd>{event.reason}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>Today {event.time}</dd>
        </div>
      </dl>
      <section className="drawer-section">
        <h3>Subject</h3>
        <dl className="detail-grid">
          <div>
            <dt>Name</dt>
            <dd>{event.subjectName}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{event.subjectType}</dd>
          </div>
          <div>
            <dt>Barcode</dt>
            <dd>{event.barcode}</dd>
          </div>
          <div>
            <dt>Direction</dt>
            <dd>{event.direction}</dd>
          </div>
          <div>
            <dt>Checkpoint</dt>
            <dd>{event.checkpoint}</dd>
          </div>
          <div>
            <dt>Scanner</dt>
            <dd>{event.scannerId}</dd>
          </div>
        </dl>
      </section>
      <section className="drawer-section">
        <h3>Actions</h3>
        <div className="drawer-actions">
          <button className="primary-button" disabled={!alert} type="button" onClick={onAcknowledge}>
            Acknowledge
          </button>
          <button className="secondary-button" disabled={!alert} type="button" onClick={onResolve}>
            Resolve
          </button>
        </div>
        <label className="note-editor">
          <span>Operator note</span>
          <textarea
            value={noteDraft}
            onChange={(event) => onNoteDraftChange(event.target.value)}
            placeholder="Add context for security handoff..."
            rows={4}
          />
        </label>
        <button className="ghost-button full" type="button" onClick={onAddNote} disabled={!noteDraft.trim()}>
          Save Note
        </button>
        {notes.length ? (
          <ul className="note-list" aria-label="Saved notes">
            {notes.map((savedNote, index) => (
              <li key={`${event.id}-note-${index}`}>{savedNote}</li>
            ))}
          </ul>
        ) : (
          <p className="inline-note">No notes saved for this event yet.</p>
        )}
      </section>
    </aside>
  );
}

function AlertsView({
  alerts,
  onUpdate,
  onBulkUpdate
}: {
  alerts: Alert[];
  onUpdate: (alertId: string, status: Alert["status"]) => void;
  onBulkUpdate: (alertIds: string[], status: Alert["status"]) => void;
}) {
  const [severityFilter, setSeverityFilter] = useState<Alert["severity"] | "all">("all");
  const [groupBySeverity, setGroupBySeverity] = useState(true);
  const [selectedAlertIds, setSelectedAlertIds] = useState<string[]>([]);
  const filteredAlerts = alerts.filter(
    (alert) => severityFilter === "all" || alert.severity === severityFilter
  );
  const groupedAlerts = groupBySeverity
    ? (["critical", "high", "medium"] as Alert["severity"][]).map((severity) => ({
        severity,
        rows: filteredAlerts.filter((alert) => alert.severity === severity)
      }))
    : [{ severity: "all" as const, rows: filteredAlerts }];
  const selectedVisibleIds = selectedAlertIds.filter((id) =>
    filteredAlerts.some((alert) => alert.id === id)
  );

  function toggleSelected(alertId: string) {
    setSelectedAlertIds((current) =>
      current.includes(alertId) ? current.filter((id) => id !== alertId) : [...current, alertId]
    );
  }

  function bulkUpdate(status: Alert["status"]) {
    if (!selectedVisibleIds.length) {
      return;
    }
    onBulkUpdate(selectedVisibleIds, status);
    setSelectedAlertIds([]);
  }

  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Alerts</h1>
          <p>Open exceptions by severity and checkpoint.</p>
        </div>
        <div className="toolbar">
          <label className="select-control compact-control">
            <span className="sr-only">Filter severity</span>
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value as Alert["severity"] | "all")}
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={groupBySeverity}
              onChange={() => setGroupBySeverity((value) => !value)}
            />
            Group
          </label>
        </div>
      </div>
      <div className="bulk-bar">
        <span>{selectedVisibleIds.length} selected</span>
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={!selectedVisibleIds.length}
          onClick={() => bulkUpdate("acknowledged")}
        >
          Acknowledge Selected
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={!selectedVisibleIds.length}
          onClick={() => bulkUpdate("resolved")}
        >
          Resolve Selected
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Select</th>
              <th>ID</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Subject</th>
              <th>Barcode</th>
              <th>Checkpoint</th>
              <th>Reason</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-table-cell">
                  <div className="empty-state compact-empty">
                    <strong>No alerts match this severity.</strong>
                    <span>Try all severities or review resolved alerts later.</span>
                  </div>
                </td>
              </tr>
            ) : null}
            {groupedAlerts.map((group) =>
              group.rows.length ? (
                <Fragment key={group.severity}>
                  {groupBySeverity ? (
                    <tr className="group-row">
                      <td colSpan={9}>{group.severity.toUpperCase()} severity</td>
                    </tr>
                  ) : null}
                  {group.rows.map((alert) => (
                    <tr key={alert.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedAlertIds.includes(alert.id)}
                          onChange={() => toggleSelected(alert.id)}
                          aria-label={`Select alert ${alert.id}`}
                        />
                      </td>
                      <td>{alert.id}</td>
                      <td>
                        <span className={`severity severity-${alert.severity}`}>{alert.severity}</span>
                      </td>
                      <td>{alert.status}</td>
                      <td>{alert.subjectName}</td>
                      <td>{alert.barcode}</td>
                      <td>{alert.checkpoint}</td>
                      <td>{alert.reason}</td>
                      <td className="row-actions">
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => onUpdate(alert.id, "acknowledged")}
                        >
                          Ack
                        </button>
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
                </Fragment>
              ) : null
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PeopleTable({
  title,
  people: rows,
  onToggleInside
}: {
  title: string;
  people: Person[];
  onToggleInside: (personId: string) => void;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>{title}</h1>
          <p>Directory records with current presence state.</p>
        </div>
        <button className="ghost-button" type="button">
          <Download />
          Export
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Barcode</th>
              <th>Access</th>
              <th>Department / Company</th>
              <th>Status</th>
              <th>Inside</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => (
              <tr key={person.id}>
                <td>{person.name}</td>
                <td>{person.barcode}</td>
                <td>{person.accessLevel}</td>
                <td>{person.department ?? person.company ?? "-"}</td>
                <td>{person.status}</td>
                <td>{person.inside ? "Inside" : "Outside"}</td>
                <td>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => onToggleInside(person.id)}
                  >
                    Toggle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HardwareTable({
  assets,
  onToggleInside
}: {
  assets: HardwareAsset[];
  onToggleInside: (assetId: string) => void;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Hardware</h1>
          <p>Hardware movement and restrictions for carried or standalone assets.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Barcode</th>
              <th>Owner</th>
              <th>Category</th>
              <th>Status</th>
              <th>Inside</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.id}>
                <td>{asset.name}</td>
                <td>{asset.barcode}</td>
                <td>{asset.owner}</td>
                <td>{asset.category}</td>
                <td>{asset.status}</td>
                <td>{asset.inside ? "Inside" : "Outside"}</td>
                <td>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => onToggleInside(asset.id)}
                  >
                    Toggle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BarcodeTable({ people: rows, assets }: { people: Person[]; assets: HardwareAsset[] }) {
  const barcodes = [
    ...rows.map((person) => ({
      barcode: person.barcode,
      owner: person.name,
      type: person.type,
      status: person.status
    })),
    ...assets.map((asset) => ({
      barcode: asset.barcode,
      owner: asset.name,
      type: "hardware",
      status: asset.status
    }))
  ];

  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Barcodes</h1>
          <p>Assigned identifiers and temporary passes.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Barcode</th>
              <th>Assigned To</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {barcodes.map((barcode) => (
              <tr key={`${barcode.type}-${barcode.barcode}`}>
                <td>{barcode.barcode}</td>
                <td>{barcode.owner}</td>
                <td>{barcode.type}</td>
                <td>{barcode.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CheckpointTable({
  scannerState,
  onToggleScanner
}: {
  scannerState: Scanner[];
  onToggleScanner: (scannerId: string) => void;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Checkpoints</h1>
          <p>Configured checkpoint modes and scanner assignments.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mode</th>
              <th>Zone</th>
              <th>Scanner</th>
              <th>Scanner Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {checkpoints.map((checkpoint) => {
              const scanner = scannerState.find((item) => item.id === checkpoint.scannerId);
              return (
                <tr key={checkpoint.id}>
                  <td>{checkpoint.name}</td>
                  <td>{checkpoint.mode}</td>
                  <td>{checkpoint.zone}</td>
                  <td>{checkpoint.scannerId}</td>
                  <td>{scanner ? <ScannerPill value={scanner.status} /> : "-"}</td>
                  <td>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => onToggleScanner(checkpoint.scannerId)}
                    >
                      Toggle Scanner
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ScannerTable({
  scannerState,
  onToggleScanner
}: {
  scannerState: Scanner[];
  onToggleScanner: (scannerId: string) => void;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Scanners</h1>
          <p>Device status for each checkpoint terminal.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th>Last Seen</th>
              <th>Version</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {scannerState.map((scanner) => (
              <tr key={scanner.id}>
                <td>{scanner.name}</td>
                <td>
                  <ScannerPill value={scanner.status} />
                </td>
                <td>{scanner.lastSeen}</td>
                <td>{scanner.version}</td>
                <td>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => onToggleScanner(scanner.id)}
                  >
                    Toggle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OfflineSyncTable({
  events,
  onResolveConflicts,
  onSync
}: {
  events: MovementEvent[];
  onResolveConflicts: (eventIds: string[]) => void;
  onSync: (eventIds?: string[]) => void;
}) {
  const queued = events.filter((event) => event.syncState !== "synced");
  const queuedIds = queued.filter((event) => event.syncState === "queued").map((event) => event.id);
  const conflictIds = queued.filter((event) => event.syncState === "conflict").map((event) => event.id);
  const [selectedIds, setSelectedIds] = useState<string[]>(queuedIds);
  const selectedQueued = selectedIds.filter((id) => queuedIds.includes(id));
  const selectedConflicts = selectedIds.filter((id) => conflictIds.includes(id));

  function toggleSelected(eventId: string) {
    setSelectedIds((current) =>
      current.includes(eventId) ? current.filter((id) => id !== eventId) : [...current, eventId]
    );
  }

  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Offline Sync</h1>
          <p>Queued and conflict events created while scanner terminals are offline.</p>
        </div>
        <div className="toolbar">
          <button
            className="primary-button"
            type="button"
            disabled={!selectedQueued.length}
            onClick={() => onSync(selectedQueued)}
          >
            Sync Selected
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedConflicts.length}
            onClick={() => onResolveConflicts(selectedConflicts)}
          >
            Resolve Conflicts
          </button>
        </div>
      </div>
      <div className="sync-guidance" role="note">
        <strong>Retry guidance:</strong> queued success and manual-review events can sync automatically. Denied,
        expired, duplicate, or restricted events move to conflict review so an operator can reconcile the record.
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Select</th>
              <th>Event</th>
              <th>Subject</th>
              <th>Checkpoint</th>
              <th>Result</th>
              <th>Reason</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {queued.map((event) => (
              <tr key={event.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(event.id)}
                    onChange={() => toggleSelected(event.id)}
                    aria-label={`Select sync event ${event.id}`}
                  />
                </td>
                <td>{event.id}</td>
                <td>{event.subjectName}</td>
                <td>{event.checkpoint}</td>
                <td>
                  <ResultPill value={event.result} />
                </td>
                <td>{event.reason}</td>
                <td>
                  <SyncPill value={event.syncState} />
                </td>
              </tr>
            ))}
            {queued.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-table-cell">
                  <div className="empty-state compact-empty">
                    <strong>No offline events are waiting.</strong>
                    <span>New queued scans will appear here when terminals reconnect.</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
