"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArcElement,
  Chart as ChartJS,
  Tooltip
} from "chart.js";
import { Doughnut } from "react-chartjs-2";
import {
  CalendarDays,
  Bell,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Filter,
  Grid2X2,
  History,
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
import { ResultPill, ScannerPill, SyncPill } from "../../components/StatusPill";
import {
  checkpoints,
  hardwareAssets,
  initialAlerts,
  initialMovements,
  people,
  scanners
} from "../../lib/mockData";
import type { Alert, HardwareAsset, MovementEvent, Person, Scanner } from "../../lib/types";

ChartJS.register(ArcElement, Tooltip);

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
  },
  {
    label: "System",
    items: [
      { view: "Checkpoints" as AdminView, icon: MapPin, label: "Checkpoints" },
      { view: "Scanners" as AdminView, icon: SlidersHorizontal, label: "Scanners" },
      { view: "Offline Sync" as AdminView, icon: RefreshCw, label: "Offline Sync" }
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
  const [activeView, setActiveView] = useState<AdminView>("Dashboard");
  const [events, setEvents] = useState<MovementEvent[]>(initialMovements);
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [staff, setStaff] = useState<Person[]>(people);
  const [assets, setAssets] = useState<HardwareAsset[]>(hardwareAssets);
  const [scannerState, setScannerState] = useState<Scanner[]>(scanners);
  const [selectedEventId, setSelectedEventId] = useState(initialMovements[0]?.id ?? "");
  const [checkpointFilter, setCheckpointFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("today");
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [page, setPage] = useState(1);
  const [showColumns, setShowColumns] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(defaultVisibleColumns);
  const [drawerNote, setDrawerNote] = useState("");

  const filteredEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      const checkpointMatch =
        checkpointFilter === "all" || event.checkpointId === checkpointFilter;
      const statusMatch = statusFilter === "all" || event.result === statusFilter;
      const searchMatch =
        !needle ||
        [event.subjectName, event.barcode, event.checkpoint, event.scannerId, event.reason]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return checkpointMatch && statusMatch && searchMatch;
    });
  }, [checkpointFilter, events, search, statusFilter]);

  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? filteredEvents[0] ?? events[0];
  const selectedAlert = alerts.find(
    (alert) =>
      alert.barcode === selectedEvent?.barcode &&
      alert.status !== "resolved" &&
      selectedEvent.result !== "success"
  );
  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / rowsPerPage));
  const pagedEvents = filteredEvents.slice((page - 1) * rowsPerPage, page * rowsPerPage);

  const metrics = useMemo(() => {
    const openAlerts = alerts.filter((alert) => alert.status !== "resolved").length;
    const queued = events.filter((event) => event.syncState !== "synced").length;
    const queuedBaseline = initialMovements.filter((event) => event.syncState !== "synced").length;
    const queuedDelta = queued - queuedBaseline;
    const localExceptions = scannerState.filter((scanner) => scanner.status !== "online").length;

    return [
      {
        label: "Total Entries",
        value: "342",
        note: "12% vs yesterday",
        tone: "good"
      },
      {
        label: "Total Exits",
        value: "289",
        note: "9% vs yesterday",
        tone: "good"
      },
      {
        label: "Active Inside",
        value: "153",
        note: "Currently inside",
        tone: "neutral"
      },
      {
        label: "Alerts",
        value: String(8 + Math.max(0, openAlerts - 3)),
        note: "Critical and high",
        tone: "bad"
      },
      {
        label: "Failed Scans",
        value: "15",
        note: "Denied, duplicate, expired",
        tone: "bad"
      },
      {
        label: "Offline Queue",
        value: String(23 + queuedDelta),
        note: "Waiting to sync",
        tone: "accent"
      },
      {
        label: "Scanner Status",
        value: "12 Online",
        note: `${localExceptions} local exceptions`,
        tone: "good"
      }
    ];
  }, [alerts, events, scannerState]);

  const gaugeCharts = useMemo(() => {
    const failedScans = events.filter((event) => event.result !== "success").length;
    const queued = events.filter((event) => event.syncState !== "synced").length;
    const onlineScanners = scannerState.filter((scanner) => scanner.status === "online").length;

    return [
      {
        title: "Entry Load",
        label: "Entries: +12%",
        value: 342,
        max: 500,
        display: "342",
        tone: "lime"
      },
      {
        title: "Active Inside",
        label: "Occupancy: +6%",
        value: 153,
        max: 220,
        display: "153",
        tone: "slate"
      },
      {
        title: "Failed Scans",
        label: "Exceptions: -4%",
        value: failedScans,
        max: 24,
        display: String(failedScans),
        tone: "alert"
      },
      {
        title: "Scanner Sync",
        label: `Queued: ${queued}`,
        value: onlineScanners,
        max: scannerState.length,
        display: `${onlineScanners}/${scannerState.length}`,
        tone: "lime"
      }
    ];
  }, [events, scannerState]);

  const gaugeOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      circumference: 180,
      rotation: -90,
      cutout: "97%",
      radius: "82%",
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: "rgba(24, 32, 31, 0.88)",
          displayColors: false
        }
      }
    }),
    []
  );

  function updateAlertStatus(alertId: string, status: Alert["status"]) {
    setAlerts((current) =>
      current.map((alert) => (alert.id === alertId ? { ...alert, status } : alert))
    );
  }

  function togglePersonInside(personId: string) {
    setStaff((current) =>
      current.map((person) =>
        person.id === personId ? { ...person, inside: !person.inside } : person
      )
    );
  }

  function toggleAssetInside(assetId: string) {
    setAssets((current) =>
      current.map((asset) => (asset.id === assetId ? { ...asset, inside: !asset.inside } : asset))
    );
  }

  function toggleScanner(scannerId: string) {
    setScannerState((current) =>
      current.map((scanner) => {
        if (scanner.id !== scannerId) {
          return scanner;
        }
        return {
          ...scanner,
          status: scanner.status === "online" ? "offline" : "online",
          lastSeen: scanner.status === "online" ? scanner.lastSeen : "Just now"
        };
      })
    );
  }

  function syncQueued() {
    setEvents((current) =>
      current.map((event) =>
        event.syncState === "queued"
          ? { ...event, syncState: event.result === "success" ? "synced" : "conflict" }
          : event
      )
    );
  }

  function clearFilters() {
    setCheckpointFilter("all");
    setStatusFilter("all");
    setSearch("");
    setDateFilter("today");
    setPage(1);
  }

  return (
    <AppChrome role="admin">
      <main className="admin-console">
        <aside className="admin-rail" aria-label="Admin quick navigation">
          <div className="admin-rail-brand">
            <Link href="/admin" className="brand">
              IN / OUT
            </Link>
            <span>Management System</span>
          </div>
          <div className="admin-rail-groups">
            {adminRailGroups.map((group) => (
              <section className="admin-rail-group" key={group.label}>
                <span className="admin-rail-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = activeView === item.view;

                  return (
                    <button
                      key={item.label}
                      className={active ? "rail-button active" : "rail-button"}
                      onClick={() => setActiveView(item.view)}
                      type="button"
                    >
                      <Icon />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
          <div className="session-chip" title="OAuth 2.0 + OIDC role session simulation">
            <span className="session-avatar">AU</span>
            <span>
              <strong>Admin User</strong>
              <small>admin@company.com</small>
            </span>
          </div>
        </aside>

        {["Dashboard", "Logs"].includes(activeView) ? (
          <>
            <div className="command-bar">
              <label className="select-control">
                <MapPin />
                <select
                  value={checkpointFilter}
                  onChange={(event) => {
                    setCheckpointFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">All Checkpoints</option>
                  {checkpoints.map((checkpoint) => (
                    <option key={checkpoint.id} value={checkpoint.id}>
                      {checkpoint.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="select-control">
                <CalendarDays />
                <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}>
                  <option value="today">Today: Jul 6, 2026</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                </select>
              </label>
              <label className="search-control">
                <Search />
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search by name, barcode, or id..."
                />
              </label>
              <label className="select-control compact">
                <SlidersHorizontal />
                <select
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">All Results</option>
                  <option value="success">Success</option>
                  <option value="denied">Denied</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="expired">Expired</option>
                  <option value="restricted">Restricted</option>
                  <option value="manual_review">Manual Review</option>
                </select>
              </label>
              <div className="scanner-summary">
                <span>Live Scanner Status</span>
                <strong>12 Online</strong>
              </div>
            </div>

            {activeView === "Dashboard" ? (
              <DashboardOverview
                gaugeOptions={gaugeOptions}
                gauges={gaugeCharts}
                metrics={metrics}
              />
            ) : null}

            <section className="split-workspace">
              <div className="workspace-main">
                <div className="panel-titlebar">
                  <div>
                    <h1>{activeView === "Dashboard" ? "Movement Log" : "Log Explorer"}</h1>
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
                    <button className="icon-button" type="button" onClick={() => setEvents([...events])}>
                      <RefreshCw />
                    </button>
                  </div>
                </div>
                <MovementTable
                  events={pagedEvents}
                  selectedId={selectedEvent?.id}
                  visibleColumns={visibleColumns}
                  onSelect={setSelectedEventId}
                />
                <div className="table-footer">
                  <div className="pagination">
                    <button
                      className="icon-button"
                      disabled={page === 1}
                      type="button"
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
                  note={drawerNote}
                  onAcknowledge={() =>
                    selectedAlert ? updateAlertStatus(selectedAlert.id, "acknowledged") : null
                  }
                  onResolve={() => (selectedAlert ? updateAlertStatus(selectedAlert.id, "resolved") : null)}
                  onAddNote={() => setDrawerNote(`Note added for ${selectedEvent.id}`)}
                  onClose={() => setSelectedEventId("")}
                />
              ) : null}
            </section>
          </>
        ) : null}

        {activeView === "Alerts" ? (
          <AlertsView alerts={alerts} onUpdate={updateAlertStatus} />
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
          <OfflineSyncTable events={events} onSync={syncQueued} />
        ) : null}
      </main>
    </AppChrome>
  );
}

function DashboardOverview({
  gaugeOptions,
  gauges,
  metrics
}: {
  gaugeOptions: object;
  gauges: {
    title: string;
    label: string;
    value: number;
    max: number;
    display: string;
    tone: string;
  }[];
  metrics: { label: string; value: string; note: string; tone: string }[];
}) {
  return (
    <section className="dashboard-overview" aria-label="Operational overview">
      <div className="metric-strip" aria-label="Operational metrics">
        {metrics.map((metric) => (
          <article key={metric.label} className="metric">
            <span>{metric.label}</span>
            <strong className={`metric-${metric.tone}`}>{metric.value}</strong>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>
      <div className="dashboard-charts">
        {gauges.map((gauge) => (
          <GaugePanel gauge={gauge} key={gauge.title} options={gaugeOptions} />
        ))}
      </div>
    </section>
  );
}

function GaugePanel({
  gauge,
  options
}: {
  gauge: { title: string; label: string; value: number; max: number; display: string; tone: string };
  options: object;
}) {
  const safeMax = Math.max(gauge.max, 1);
  const value = Math.min(Math.max(gauge.value, 0), safeMax);
  const marker = Math.min(Math.max(safeMax * 0.055, 1), value || 1);
  const markerStart = Math.max(value - marker, 0);
  const markerEnd = Math.max(safeMax - value, 0);
  const accent =
    gauge.tone === "alert"
      ? "rgba(181, 80, 72, 0.8)"
      : gauge.tone === "slate"
        ? "rgba(66, 82, 90, 0.68)"
        : "rgba(239, 255, 112, 0.86)";

  return (
    <section className={`chart-panel gauge-panel gauge-${gauge.tone}`} aria-label={gauge.title}>
      <div className="chart-titlebar">
        <h2>{gauge.title}</h2>
      </div>
      <div className="gauge-canvas">
        <Doughnut
          data={{
            labels: ["Track", "Progress lead", gauge.title, "Progress tail"],
            datasets: [
              {
                data: [safeMax],
                backgroundColor: ["rgba(48, 62, 60, 0.11)"],
                borderColor: "transparent",
                borderRadius: 999,
                weight: 1
              },
              {
                data: [markerStart, marker, markerEnd],
                backgroundColor: ["transparent", accent, "transparent"],
                borderColor: "transparent",
                borderRadius: 999,
                weight: 1
              }
            ]
          }}
          options={options}
        />
        <div className="gauge-readout">
          <span>{gauge.label}</span>
          <strong>{gauge.display}</strong>
        </div>
      </div>
    </section>
  );
}

function MovementTable({
  events,
  selectedId,
  visibleColumns,
  onSelect
}: {
  events: MovementEvent[];
  selectedId?: string;
  visibleColumns: Record<VisibleColumn, boolean>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table movement-table">
        <thead>
          <tr>
            {visibleColumns.time ? <th>Time</th> : null}
            {visibleColumns.checkpoint ? <th>Checkpoint</th> : null}
            {visibleColumns.direction ? <th>Direction</th> : null}
            {visibleColumns.subject ? <th>Subject</th> : null}
            {visibleColumns.type ? <th>Type</th> : null}
            {visibleColumns.barcode ? <th>Barcode</th> : null}
            {visibleColumns.result ? <th>Result</th> : null}
            {visibleColumns.reason ? <th>Reason</th> : null}
            {visibleColumns.scanner ? <th>Scanner</th> : null}
            {visibleColumns.sync ? <th>Sync</th> : null}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr
              key={event.id}
              className={selectedId === event.id ? "selected" : ""}
              onClick={() => onSelect(event.id)}
            >
              {visibleColumns.time ? <td>{event.time}</td> : null}
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
  note,
  onAcknowledge,
  onResolve,
  onAddNote,
  onClose
}: {
  alert?: Alert;
  event: MovementEvent;
  note: string;
  onAcknowledge: () => void;
  onResolve: () => void;
  onAddNote: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="detail-drawer" aria-label="Movement details">
      <div className="drawer-header">
        <h2>{event.result === "success" ? "Movement Details" : "Alert Details"}</h2>
        <button className="icon-button" type="button" onClick={onClose}>
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
          <dd>Jul 6, 2026 {event.time}</dd>
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
        <button className="ghost-button full" type="button" onClick={onAddNote}>
          Add Note
        </button>
        {note ? <p className="inline-note">{note}</p> : null}
      </section>
    </aside>
  );
}

function AlertsView({
  alerts,
  onUpdate
}: {
  alerts: Alert[];
  onUpdate: (alertId: string, status: Alert["status"]) => void;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Alerts</h1>
          <p>Open exceptions by severity and checkpoint.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
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
            {alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{alert.id}</td>
                <td>{alert.severity}</td>
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
              <th>Battery</th>
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
                <td>{scanner.battery}%</td>
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
  onSync
}: {
  events: MovementEvent[];
  onSync: () => void;
}) {
  const queued = events.filter((event) => event.syncState !== "synced");

  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Offline Sync</h1>
          <p>Queued and conflict events created while scanner terminals are offline.</p>
        </div>
        <button className="primary-button" type="button" onClick={onSync}>
          Sync Queue
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
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
                <td>{event.id}</td>
                <td>{event.subjectName}</td>
                <td>{event.checkpoint}</td>
                <td>
                  <ResultPill value={event.result} />
                </td>
                <td>{event.reason}</td>
                <td>{event.syncState}</td>
              </tr>
            ))}
            {queued.length === 0 ? (
              <tr>
                <td colSpan={6}>No offline events are waiting.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
