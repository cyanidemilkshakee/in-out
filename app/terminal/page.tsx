"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Keyboard,
  Laptop,
  Menu,
  MoreVertical,
  RefreshCw,
  UserRound,
  Wifi,
  WifiOff,
  XCircle
} from "lucide-react";
import { AppChrome } from "../../components/AppChrome";
import { ResultPill } from "../../components/StatusPill";
import {
  checkpoints,
  hardwareAssets,
  initialMovements,
  people,
  scanners
} from "../../lib/mockData";
import { applyMovementState, evaluateScan } from "../../lib/movementLogic";
import type { HardwareAsset, MovementEvent, Person, ScanDecision, SubjectRecord } from "../../lib/types";

const terminalTabs = ["Subject", "Hardware", "Activity", "Offline Queue", "Conflicts"] as const;
type TerminalTab = (typeof terminalTabs)[number];

function isHardware(subject: SubjectRecord | undefined): subject is HardwareAsset {
  return Boolean(subject && "category" in subject);
}

function initials(name: string) {
  return name
    .split(" ")
    .map((piece) => piece[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const initialTerminalCheckpoint = checkpoints[0];
const initialTerminalSubject = people.find((person) => person.barcode === "test2");
const initialTerminalDecision: ScanDecision = {
  subject: initialTerminalSubject,
  carriedHardware: [],
  event: {
    id: "EVT-001000",
    time: "10:25:18 AM",
    checkpointId: initialTerminalCheckpoint.id,
    checkpoint: initialTerminalCheckpoint.name,
    direction: "entry",
    subjectId: initialTerminalSubject?.id ?? "unknown",
    subjectName: initialTerminalSubject?.name ?? "Unknown barcode",
    subjectType: initialTerminalSubject?.type ?? "visitor",
    barcode: "test2",
    result: "success",
    reason: "-",
    scannerId: initialTerminalCheckpoint.scannerId,
    syncState: "synced",
    hardwareIds: []
  }
};

export default function TerminalPage() {
  const [personState, setPersonState] = useState<Person[]>(people);
  const [assetState, setAssetState] = useState<HardwareAsset[]>(hardwareAssets);
  const [events, setEvents] = useState<MovementEvent[]>(initialMovements);
  const [checkpointId, setCheckpointId] = useState("cp-main");
  const [online, setOnline] = useState(true);
  const [barcode, setBarcode] = useState("test2");
  const [selectedHardwareIds, setSelectedHardwareIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<TerminalTab>("Subject");
  const [menuOpen, setMenuOpen] = useState(false);
  const [decision, setDecision] = useState<ScanDecision>(initialTerminalDecision);

  const checkpoint = checkpoints.find((item) => item.id === checkpointId) ?? checkpoints[0];
  const scanner = scanners.find((item) => item.id === checkpoint.scannerId) ?? scanners[0];
  const queuedEvents = events.filter((event) => event.syncState === "queued");
  const conflictEvents = events.filter((event) => event.syncState === "conflict");
  const selectedHardware = assetState.filter((asset) => selectedHardwareIds.includes(asset.id));
  const subject = decision.subject;

  const subjectLastMovement = useMemo(() => {
    if (!subject) {
      return undefined;
    }
    return events.find((event) => event.subjectId === subject.id);
  }, [events, subject]);

  function runScan(nextBarcode = barcode) {
    const scan = evaluateScan({
      barcode: nextBarcode,
      checkpoint,
      people: personState,
      hardware: assetState,
      selectedHardwareIds,
      online,
      eventCount: events.length + 1
    });
    const movementState = applyMovementState(scan.event, personState, assetState);
    setDecision(scan);
    setEvents((current) => [scan.event, ...current]);
    setPersonState(movementState.people);
    setAssetState(movementState.hardware);
    setBarcode(nextBarcode);
  }

  function toggleHardware(assetId: string) {
    setSelectedHardwareIds((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId]
    );
  }

  function syncQueue() {
    if (!online) {
      return;
    }
    setEvents((current) =>
      current.map((event) => {
        if (event.syncState !== "queued") {
          return event;
        }
        return {
          ...event,
          syncState: event.result === "success" || event.result === "manual_review" ? "synced" : "conflict"
        };
      })
    );
  }

  function sendToManualReview() {
    const reviewEvent: MovementEvent = {
      ...decision.event,
      result: "manual_review",
      reason: "Security escalated for manual review",
      syncState: online ? "synced" : "queued"
    };
    setDecision({ ...decision, event: reviewEvent });
    setEvents((current) =>
      current.some((event) => event.id === reviewEvent.id)
        ? current.map((event) => (event.id === reviewEvent.id ? reviewEvent : event))
        : [reviewEvent, ...current]
    );
  }

  return (
    <AppChrome role="security">
      <main className="terminal-page">
        <section className="terminal-shell">
          <div className="terminal-header">
            <div>
              <h1>Security Terminal</h1>
              <span>Terminal-01 / checkpoint operations</span>
            </div>
            <div className="terminal-header-actions">
              <button
                className={online ? "network-toggle online" : "network-toggle offline"}
                type="button"
                onClick={() => setOnline((value) => !value)}
              >
                {online ? <Wifi /> : <WifiOff />}
                {online ? "Online" : "Offline"}
              </button>
              <button className="icon-button" type="button" onClick={() => setMenuOpen((value) => !value)}>
                <Menu />
              </button>
            </div>
          </div>

          {menuOpen ? (
            <div className="terminal-menu">
              <button type="button" onClick={() => setActiveTab("Offline Queue")}>
                Review offline queue
              </button>
              <button type="button" onClick={syncQueue}>
                Sync current queue
              </button>
              <button type="button" onClick={() => runScan("test1")}>
                Run test1 employee scan
              </button>
            </div>
          ) : null}

          <div className="terminal-status-grid">
            <label>
              <span>Checkpoint</span>
              <select value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}>
                {checkpoints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span>Status</span>
              <strong className={online ? "text-online" : "text-offline"}>
                {online ? "Online" : "Offline"}
              </strong>
            </div>
            <div>
              <span>Queue</span>
              <strong>{queuedEvents.length}</strong>
            </div>
            <div>
              <span>Device</span>
              <strong>{scanner.name}</strong>
              <small>{scanner.version}</small>
            </div>
          </div>

          <div className="terminal-workspace">
            <div className="terminal-primary">
              <section className="scan-panel">
                <label className="scan-input-label">
                  Scan Barcode
                  <span className="scan-input">
                    <input
                      value={barcode}
                      onChange={(event) => setBarcode(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          runScan();
                        }
                      }}
                      autoComplete="off"
                    />
                    <button className="icon-button" type="button" onClick={() => runScan()}>
                      <Keyboard />
                    </button>
                  </span>
                </label>
                <div className="sample-row">
                  <span>Samples</span>
                  {["test1", "test2", "test3"].map((sample) => (
                    <button
                      key={sample}
                      className={barcode === sample ? "sample-button active" : "sample-button"}
                      type="button"
                      onClick={() => runScan(sample)}
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </section>

              <DecisionPanel decision={decision} />

              <div className="terminal-actions">
                <button className="secondary-button wide" type="button" onClick={sendToManualReview}>
                  <RefreshCw />
                  Manual Review
                </button>
                <button className="secondary-button square" type="button" onClick={() => setMenuOpen((value) => !value)}>
                  <MoreVertical />
                </button>
              </div>
            </div>

            <aside className="terminal-secondary" aria-label="Terminal details">
              <nav className="terminal-tabs" aria-label="Terminal detail tabs">
                {terminalTabs.map((tab) => {
                  const label =
                    tab === "Offline Queue"
                      ? `Offline Queue (${queuedEvents.length})`
                      : tab === "Conflicts"
                        ? `Conflicts (${conflictEvents.length})`
                        : tab;
                  return (
                    <button
                      key={tab}
                      className={activeTab === tab ? "terminal-tab active" : "terminal-tab"}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                    >
                      {label}
                    </button>
                  );
                })}
              </nav>

              <section className="terminal-detail-panel">
                {activeTab === "Subject" ? (
                  <SubjectPanel subject={subject} lastMovement={subjectLastMovement} />
                ) : null}
                {activeTab === "Hardware" ? (
                  <HardwarePicker
                    assets={assetState}
                    selectedHardware={selectedHardwareIds}
                    onToggle={toggleHardware}
                  />
                ) : null}
                {activeTab === "Activity" ? <ActivityPanel events={events} /> : null}
                {activeTab === "Offline Queue" ? (
                  <QueuePanel events={queuedEvents} online={online} onSync={syncQueue} />
                ) : null}
                {activeTab === "Conflicts" ? <ConflictPanel events={conflictEvents} /> : null}
              </section>
            </aside>
          </div>
        </section>

        <footer className="terminal-footer">
          <span>Today: 342 In / 289 Out</span>
          <span>Active Inside: 153</span>
          <span>Failed Scans: {events.filter((event) => event.result !== "success").length}</span>
          <span>Offline: {queuedEvents.length}</span>
        </footer>
      </main>
    </AppChrome>
  );
}

function DecisionPanel({ decision }: { decision: ScanDecision }) {
  const { event } = decision;
  const success = event.result === "success";
  const manual = event.result === "manual_review" || event.result === "pending";
  const title = success
    ? `${event.direction.toUpperCase()} ALLOWED`
    : event.result === "duplicate"
      ? "DUPLICATE SCAN"
      : event.result === "expired"
        ? "BARCODE EXPIRED"
        : event.result === "restricted"
          ? "RESTRICTED MOVEMENT"
          : manual
            ? "MANUAL REVIEW"
            : "ACCESS DENIED";

  return (
    <section className={`decision-panel decision-${event.result}`} aria-live="polite">
      <div className="decision-banner">
        <div className="decision-icon">
          {success ? (
            <CheckCircle2 />
          ) : manual ? (
            <AlertTriangle />
          ) : (
            <XCircle />
          )}
        </div>
        <div>
          <span>Decision</span>
          <h2>{title}</h2>
          <p>{event.reason === "-" ? "Auto-determined by checkpoint rule" : event.reason}</p>
        </div>
      </div>
      <div className="decision-facts">
        <div>
          <span>Direction</span>
          <strong>{event.direction}</strong>
        </div>
        <div>
          <span>Time</span>
          <strong>{event.time}</strong>
        </div>
        <div>
          <span>Ref ID</span>
          <strong>{event.id}</strong>
        </div>
        <div>
          <span>Sync</span>
          <strong>{event.syncState}</strong>
        </div>
      </div>
    </section>
  );
}

function SubjectPanel({
  subject,
  lastMovement
}: {
  subject?: SubjectRecord;
  lastMovement?: MovementEvent;
}) {
  if (!subject) {
    return (
      <div className="subject-card">
        <div className="empty-state">
          <AlertTriangle />
          <strong>Unknown barcode</strong>
          <span>No matching employee, visitor, or hardware record was found.</span>
        </div>
      </div>
    );
  }

  const hardware = isHardware(subject);
  const label = hardware ? "Hardware" : subject.type === "visitor" ? "Visitor" : "Employee";

  return (
    <div className="subject-card">
      <div className="subject-heading">
        <div className="subject-avatar">{hardware ? <Laptop /> : initials(subject.name)}</div>
        <div>
          <h3>{subject.name}</h3>
          <span className="pill neutral">{label}</span>
        </div>
      </div>
      <div className="subject-grid">
        <div>
          <span>{hardware ? "Asset ID" : "Barcode"}</span>
          <strong>{subject.barcode}</strong>
        </div>
        <div>
          <span>{hardware ? "Owner" : "Access Level"}</span>
          <strong>{hardware ? subject.owner : subject.accessLevel}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{subject.status}</strong>
        </div>
        <div>
          <span>Presence</span>
          <strong>{subject.inside ? "Inside" : "Outside"}</strong>
        </div>
      </div>
      <div className="last-movement">
        <div>
          <span>Last Movement</span>
          <strong>{lastMovement?.checkpoint ?? "No movement yet"}</strong>
        </div>
        <div>
          <Clock3 />
          <span>{lastMovement ? `${lastMovement.time} / ${lastMovement.direction}` : "Waiting"}</span>
        </div>
      </div>
      {!hardware && subject.type === "visitor" ? (
        <div className="visitor-note">
          <span>Temporary barcode</span>
          <strong>{subject.validFrom} to {subject.validTo}</strong>
          <small>Host: {subject.host} / Purpose: {subject.purpose}</small>
        </div>
      ) : null}
    </div>
  );
}

function HardwarePicker({
  assets,
  selectedHardware,
  onToggle
}: {
  assets: HardwareAsset[];
  selectedHardware: string[];
  onToggle: (assetId: string) => void;
}) {
  return (
    <div className="hardware-picker">
      {assets.map((asset) => (
        <label key={asset.id} className="hardware-row">
          <input
            type="checkbox"
            checked={selectedHardware.includes(asset.id)}
            onChange={() => onToggle(asset.id)}
          />
          <span>
            <strong>{asset.name}</strong>
            <small>{asset.barcode} / {asset.owner}</small>
          </span>
          <em>{asset.status}</em>
        </label>
      ))}
    </div>
  );
}

function ActivityPanel({ events }: { events: MovementEvent[] }) {
  return (
    <div className="compact-table-wrap">
      <table className="data-table compact-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Subject</th>
            <th>Result</th>
            <th>Sync</th>
          </tr>
        </thead>
        <tbody>
          {events.slice(0, 8).map((event) => (
            <tr key={event.id}>
              <td>{event.time}</td>
              <td>{event.subjectName}</td>
              <td>
                <ResultPill value={event.result} />
              </td>
              <td>{event.syncState}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueuePanel({
  events,
  online,
  onSync
}: {
  events: MovementEvent[];
  online: boolean;
  onSync: () => void;
}) {
  return (
    <div className="queue-panel">
      <button className="primary-button full" disabled={!online || events.length === 0} type="button" onClick={onSync}>
        Sync Queue
      </button>
      {events.map((event) => (
        <div key={event.id} className="queue-row">
          <strong>{event.subjectName}</strong>
          <span>{event.checkpoint} / {event.result}</span>
        </div>
      ))}
      {events.length === 0 ? <p className="inline-note">No offline scans waiting.</p> : null}
    </div>
  );
}

function ConflictPanel({ events }: { events: MovementEvent[] }) {
  return (
    <div className="queue-panel">
      {events.map((event) => (
        <div key={event.id} className="queue-row conflict">
          <strong>{event.subjectName}</strong>
          <span>{event.reason}</span>
        </div>
      ))}
      {events.length === 0 ? <p className="inline-note">No sync conflicts.</p> : null}
    </div>
  );
}
