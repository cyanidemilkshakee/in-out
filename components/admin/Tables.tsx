import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, BadgePlus, Download, GitBranch, X } from 'lucide-react';
import { ResultPill, ScannerPill, SyncPill } from '../StatusPill';
import {
  activePresence,
  checkpoints,
  employeeRecords,
  offlineSyncBatches,
  roles,
  shiftPolicies,
  users
} from '../../lib/mockData';
import type { Alert, HardwareAsset, MovementEvent, Person, Scanner, SortDirection, VisibleColumn } from '../../lib/types';

export function AdminPageFrame({
  title,
  description,
  metric,
  children
}: {
  title: string;
  description: string;
  metric?: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-page-frame">
      <section className="admin-model-hero">
        <div className="admin-hero-copy">
          <span>Operations model</span>
          <h1>{title}</h1>
          <p>{description}</p>
          {metric ? <strong>{metric}</strong> : null}
        </div>
        <DatabaseModelStrip />
      </section>
      {children}
    </div>
  );
}

function DatabaseModelStrip() {
  const modelTables = [
    { name: "roles", count: roles.length, detail: `${roles.reduce((sum, role) => sum + role.permissions.length, 0)} permissions` },
    { name: "users", count: users.length, detail: `${users.filter((user) => user.status === "active").length} active` },
    { name: "employees", count: employeeRecords.length, detail: `${new Set(employeeRecords.map((employee) => employee.department)).size} departments` },
    { name: "shift_policies", count: shiftPolicies.length, detail: `${shiftPolicies.filter((policy) => policy.status === "active").length} active` },
    { name: "active_presence", count: activePresence.length, detail: `${activePresence.filter((presence) => presence.state === "held").length} held` },
    { name: "offline_sync_batches", count: offlineSyncBatches.length, detail: `${offlineSyncBatches.reduce((sum, batch) => sum + batch.conflictCount, 0)} conflicts` }
  ];

  return (
    <div className="database-model-strip" aria-label="Mock database model summary">
      <div className="model-strip-title">
        <GitBranch />
        <div>
          <strong>Mock database is populated</strong>
          <span>Admin pages read from these entity groups instead of a static diagram.</span>
        </div>
      </div>
      <div className="model-table-list">
        {modelTables.map((table) => (
          <div className="model-table-row" key={table.name}>
            <span>{table.name}</span>
            <strong>{table.count}</strong>
            <small>{table.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

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

export function DetailDrawer({
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

export function AlertsView({
  alerts,
  onUpdate,
  onBulkUpdate
}: {
  alerts: Alert[];
  onUpdate: (alertId: string, status: Alert["status"]) => void;
  onBulkUpdate: (alertIds: string[], status: Alert["status"]) => void;
}) {
  const [severityFilter, setSeverityFilter] = useState<Alert["severity"] | "all">("all");
  const [statusFilter, setStatusFilter] = useState<Alert["status"] | "active" | "all">("all");
  const [groupBySeverity, setGroupBySeverity] = useState(true);
  const [selectedAlertIds, setSelectedAlertIds] = useState<string[]>([]);
  const activeAlerts = alerts.filter((alert) => alert.status === "open");
  const filteredAlerts = alerts.filter(
    (alert) =>
      (severityFilter === "all" || alert.severity === severityFilter) &&
      (statusFilter === "all" ||
        (statusFilter === "active" && alert.status === "open") ||
        alert.status === statusFilter)
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
          <p>All alert history with active exceptions surfaced first.</p>
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
          <label className="select-control compact-control">
            <span className="sr-only">Filter status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as Alert["status"] | "active" | "all")}
            >
              <option value="all">All Alerts</option>
              <option value="active">Active Alerts</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
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
      <div className="alert-summary-strip">
        <div>
          <span>Active alerts</span>
          <strong>{activeAlerts.length}</strong>
        </div>
        <div>
          <span>All alerts</span>
          <strong>{alerts.length}</strong>
        </div>
        <div>
          <span>Critical open</span>
          <strong>{alerts.filter((alert) => alert.status === "open" && alert.severity === "critical").length}</strong>
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
                      <td>
                        <span className={`alert-status alert-status-${alert.status}`}>{alert.status}</span>
                      </td>
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

export function PeopleTable({
  title,
  people: rows,
  onToggleInside,
  action
}: {
  title: string;
  people: Person[];
  onToggleInside: (personId: string) => void;
  action?: ReactNode;
}) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>{title}</h1>
          <p>Directory records with current presence state.</p>
        </div>
        <div className="toolbar">
          {action}
          <button className="ghost-button" type="button">
            <Download />
            Export
          </button>
        </div>
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

export function TemporaryVisitorCreator({ onCreate }: { onCreate: (person: Person) => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState("");
  const [hours, setHours] = useState(4);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const start = new Date();
    const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
    onCreate({
      id: `vis-temp-${suffix}`,
      name: name.trim() || `Temporary Visitor ${suffix}`,
      type: "visitor",
      barcode: `V-TEMP-${suffix}`,
      company: company.trim() || "Walk-in",
      phone: "+91 00000 00000",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "pre_approved",
      host: host.trim() || "Security Desk",
      purpose: "Temporary visit",
      validFrom: start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      validTo: end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      inside: false
    });
    setName("");
    setCompany("");
    setHost("");
    setHours(4);
  }

  return (
    <form className="temporary-id-form" onSubmit={submit}>
      <div>
        <BadgePlus />
        <strong>Create Temporary Visitor ID</strong>
        <span>Updates the mock-backed visitor table immediately.</span>
      </div>
      <label>
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Visitor name" />
      </label>
      <label>
        <span>Company</span>
        <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Company or walk-in" />
      </label>
      <label>
        <span>Host</span>
        <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="Host employee" />
      </label>
      <label>
        <span>Hours</span>
        <input
          min={1}
          max={24}
          type="number"
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
        />
      </label>
      <button className="primary-button" type="submit">
        Create ID
      </button>
    </form>
  );
}

export function HardwareTable({
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

export function BarcodeTable({ people: rows, assets }: { people: Person[]; assets: HardwareAsset[] }) {
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

export function CheckpointTable({
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

export function ScannerTable({
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

export function OfflineSyncTable({
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
