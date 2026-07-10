"use client";

import { type KeyboardEvent, useMemo, useState } from "react";
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
import { ToastRegion, type ToastMessage } from "../../components/ToastRegion";
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
  const [scanError, setScanError] = useState("");
  const [syncMessage, setSyncMessage] = useState("Queue ready");
  const [toast, setToast] = useState<ToastMessage | null>(null);

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

  function showToast(message: string, actionLabel?: string, onAction?: () => void) {
    setToast({ id: Date.now(), message, actionLabel, onAction });
  }

  function runScan(nextBarcode = barcode) {
    const normalizedBarcode = nextBarcode.trim();
    if (!normalizedBarcode) {
      setScanError("Enter or scan a barcode before running a decision.");
      return;
    }

    const scan = evaluateScan({
      barcode: normalizedBarcode,
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
    setBarcode(normalizedBarcode);
    setScanError("");
    showToast(`${scan.event.subjectName} scan recorded as ${scan.event.result}.`);
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
      setSyncMessage("Sync failed: terminal is offline. Reconnect and retry.");
      showToast("Sync failed while offline.");
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
    setSyncMessage("Queue sync complete. Review conflicts before handoff.");
    showToast("Offline queue processed.");
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
    showToast("Scan sent to manual review.");
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, tab: TerminalTab) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const currentIndex = terminalTabs.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? terminalTabs.length - 1
          : event.key === "ArrowRight"
            ? (currentIndex + 1) % terminalTabs.length
            : (currentIndex - 1 + terminalTabs.length) % terminalTabs.length;
    const nextTab = terminalTabs[nextIndex];
    setActiveTab(nextTab);
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabButtons?.[nextIndex]?.focus();
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
                aria-pressed={online}
                onClick={() => setOnline((value) => !value)}
              >
                {online ? <Wifi /> : <WifiOff />}
                {online ? "Online" : "Offline"}
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Open terminal menu"
                aria-expanded={menuOpen}
                aria-controls="terminal-menu"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <Menu />
              </button>
            </div>
          </div>

          {menuOpen ? (
            <div className="terminal-menu" id="terminal-menu">
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
              <small>{syncMessage}</small>
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
                      aria-invalid={Boolean(scanError)}
                      aria-describedby={scanError ? "scan-error" : undefined}
                      placeholder="Scan or enter barcode"
                    />
                    <button className="icon-button" type="button" onClick={() => runScan()} aria-label="Run barcode scan">
                      <Keyboard />
                    </button>
                  </span>
                  {scanError ? (
                    <span className="field-error" id="scan-error">
                      {scanError}
                    </span>
                  ) : null}
                </label>
                <div className="sample-row">
                  <span>Samples</span>
                  {["test1", "test2", "test3"].map((sample) => (
                    <button
                      key={sample}
                      className={barcode === sample ? "sample-button active" : "sample-button"}
                      type="button"
                      aria-pressed={barcode === sample}
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
                <button
                  className="secondary-button square"
                  type="button"
                  aria-label="More terminal actions"
                  onClick={() => setMenuOpen((value) => !value)}
                >
                  <MoreVertical />
                </button>
              </div>
              <RecentScansTimeline events={events} />
            </div>

            <aside className="terminal-secondary" aria-label="Terminal details">
              <nav className="terminal-tabs" aria-label="Terminal detail tabs" role="tablist">
                {terminalTabs.map((tab) => {
                  const label =
                    tab === "Offline Queue"
                      ? `Offline Queue (${queuedEvents.length})`
                      : tab === "Conflicts"
                        ? `Conflicts (${conflictEvents.length})`
                        : tab;
                  return (
                    <button
                      id={`terminal-tab-${tab.replace(/\s+/g, "-").toLowerCase()}`}
                      key={tab}
                      className={activeTab === tab ? "terminal-tab active" : "terminal-tab"}
                      role="tab"
                      aria-selected={activeTab === tab}
                      aria-controls={`terminal-panel-${tab.replace(/\s+/g, "-").toLowerCase()}`}
                      tabIndex={activeTab === tab ? 0 : -1}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      onKeyDown={(event) => handleTabKey(event, tab)}
                    >
                      {label}
                    </button>
                  );
                })}
              </nav>

              <section
                className="terminal-detail-panel"
                id={`terminal-panel-${activeTab.replace(/\s+/g, "-").toLowerCase()}`}
                role="tabpanel"
                aria-labelledby={`terminal-tab-${activeTab.replace(/\s+/g, "-").toLowerCase()}`}
              >
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
        <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
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
      <p className="operator-guidance">
        {success
          ? "Proceed after visually confirming the subject and any carried hardware."
          : manual
            ? "Hold the subject at the checkpoint and document the reason before handoff."
            : "Do not permit movement. Confirm identity, checkpoint rules, and escalate if the subject disputes the result."}
      </p>
    </section>
  );
}

function RecentScansTimeline({ events }: { events: MovementEvent[] }) {
  return (
    <section className="recent-scans" aria-label="Recent scans timeline">
      <h2>Recent Scans</h2>
      <ol>
        {events.slice(0, 5).map((event) => (
          <li key={event.id}>
            <span>{event.time}</span>
            <strong>{event.subjectName}</strong>
            <ResultPill value={event.result} />
          </li>
        ))}
      </ol>
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
        {online ? "Sync Queue" : "Reconnect to Sync"}
      </button>
      {!online ? (
        <p className="inline-note warning-note">Terminal is offline. Reconnect network, then retry the queue.</p>
      ) : null}
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
      {events.length ? (
        <p className="inline-note warning-note">
          Conflicts need operator review before records are considered final. Compare the checkpoint log with the
          subject status before resolving.
        </p>
      ) : null}
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
