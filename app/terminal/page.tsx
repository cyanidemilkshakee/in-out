"use client";

import { type KeyboardEvent, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Keyboard,
  Radio,
  Wifi,
  WifiOff,
} from "lucide-react";
import { AppChrome } from "../../components/AppChrome";
import { ToastRegion, type ToastMessage } from "../../components/ToastRegion";
import {
  checkpoints,
  hardwareAssets,
  initialMovements,
  people
} from "../../lib/mockData";
import { applyMovementState, evaluateScan } from "../../lib/movementLogic";
import type { HardwareAsset, MovementEvent, Person, ScanDecision } from "../../lib/types";

import { DecisionPanel, RecentScansTimeline, SubjectPanel, HardwarePicker, ActivityPanel, QueuePanel, ConflictPanel } from "../../components/terminal/Panels";

const terminalTabs = ["Subject", "Hardware", "Activity", "Offline Queue", "Conflicts"] as const;
type TerminalTab = (typeof terminalTabs)[number];

const initialTerminalCheckpoint = checkpoints[0];
const initialTerminalSubject = people.find((person) => person.barcode === "test2");
const initialTerminalDecision: ScanDecision = {
  subject: initialTerminalSubject,
  carriedHardware: [],
  event: {
    id: "EVT-001000",
    date: "Jul 14, 2026",
    time: "10:25:18 AM",
    checkpointId: initialTerminalCheckpoint.id,
    checkpoint: initialTerminalCheckpoint.name,
    direction: "entry",
    subjectId: initialTerminalSubject?.id ?? "unknown",
    subjectName: initialTerminalSubject?.name ?? "Unknown barcode",
    subjectType: initialTerminalSubject?.type ?? "visitor",
    barcode: "test2",
    result: "approved",
    reason: "-",
    scanType: "manual",
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
  const [decision, setDecision] = useState<ScanDecision>(initialTerminalDecision);
  const [scanError, setScanError] = useState("");
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const checkpoint = checkpoints.find((item) => item.id === checkpointId) ?? checkpoints[0];
  const { queuedEvents, conflictEvents, failedEvents, approvedCount } = useMemo(() => {
    const queued: MovementEvent[] = [];
    const conflict: MovementEvent[] = [];
    const failed: MovementEvent[] = [];

    for (const event of events) {
      if (event.syncState === "queued") queued.push(event);
      if (event.syncState === "conflict") conflict.push(event);
      if (event.result !== "approved") failed.push(event);
    }

    return {
      queuedEvents: queued,
      conflictEvents: conflict,
      failedEvents: failed,
      approvedCount: events.length - failed.length
    };
  }, [events]);
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
      eventCount: events.length + 1,
      scanType: "manual"
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
          syncState: event.result === "approved" ? "synced" : "conflict"
        };
      })
    );
    showToast("Offline queue processed.");
  }

  function sendToManualReview() {
    const reviewEvent: MovementEvent = {
      ...decision.event,
      result: "denied",
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
      <main className="terminalPage">
        <section className="terminalShell">
          <div className="terminalHeader">
            <div className="brand">
              <h1>Security Command Center</h1>
              <span>Terminal-01 / checkpoint operations</span>
            </div>
            <div className="headerActions">
              <div className="terminalOperator">
                <span>Operator</span>
                <strong>Security Staff</strong>
              </div>
              <button
                className="networkToggle"
                type="button"
                aria-pressed={online}
                onClick={() => setOnline((value) => !value)}
              >
                {online ? <Wifi className="onlineIcon" /> : <WifiOff className="offlineIcon" />}
                {online ? "Online" : "Offline"}
              </button>
            </div>
          </div>

          <div className="statusGrid">
            <label className="statusItem">
              <span>Active Checkpoint</span>
              <select value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}>
                {checkpoints.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="statusItem">
              <span>System Status</span>
              <strong style={{ color: online ? 'var(--green)' : 'var(--red)' }}>
                {online ? "Secure & Connected" : "Local Mode Only"}
              </strong>
            </div>
            <div className="statusItem">
              <span>Sync Queue</span>
              <strong>{queuedEvents.length}</strong>
            </div>
            <div className="statusItem">
              <span>Conflicts</span>
              <strong>{conflictEvents.length}</strong>
            </div>
          </div>

          <div className="workspace">
            <div className="mainStage">
              <section className="terminalHero">
                <div className="terminalHeroCopy">
                  <span>Live checkpoint terminal</span>
                  <h2>{checkpoint.name}</h2>
                  <p>{online ? "Connected to the admin event ledger." : "Local mode active. Scans queue until sync resumes."}</p>
                </div>
                <div className="terminalHeroMetrics" aria-label="Terminal metrics">
                  <div>
                    <CheckCircle2 />
                    <span>Approved</span>
                    <strong>{approvedCount}</strong>
                  </div>
                  <div>
                    <AlertTriangle />
                    <span>Failed</span>
                    <strong>{failedEvents.length}</strong>
                  </div>
                  <div>
                    <Radio />
                    <span>Queued</span>
                    <strong>{queuedEvents.length}</strong>
                  </div>
                </div>
              </section>

              <section className="terminalOpsGrid">
                <div className="terminalScanCard">
                  <div className="terminalCardTitle">
                    <span>Scan input</span>
                    <strong>Subject barcode</strong>
                  </div>
                  <div className="scanInputWrapper">
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
                      placeholder="ENTER BARCODE..."
                    />
                    <button type="button" onClick={() => runScan()} aria-label="Run barcode scan">
                      <Keyboard />
                    </button>
                  </div>
                  {scanError ? <span className="scanError">{scanError}</span> : null}
                  <div className="samples" aria-label="Sample scan barcodes">
                    {["test1", "test2", "test3"].map((sample) => (
                      <button
                        key={sample}
                        className={`${"sampleBtn"} ${barcode === sample ? "active" : ''}`}
                        type="button"
                        aria-pressed={barcode === sample}
                        onClick={() => runScan(sample)}
                      >
                        {sample}
                      </button>
                    ))}
                  </div>
                </div>

                <DecisionPanel decision={decision} onManualReview={sendToManualReview} />
              </section>
              <RecentScansTimeline events={events} />
            </div>

            <aside className="sidebar">
              <nav className="tabList" role="tablist">
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
                      className={`${"tabBtn"} ${activeTab === tab ? "active" : ''}`}
                      role="tab"
                      aria-selected={activeTab === tab}
                      onClick={() => setActiveTab(tab)}
                      onKeyDown={(event) => handleTabKey(event, tab)}
                    >
                      {label}
                    </button>
                  );
                })}
              </nav>

              <section className="tabPanel" role="tabpanel">
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

          <footer className="footer">
            <span>TOTAL SCANS: 342 IN / 289 OUT</span>
            <span>ACTIVE INSIDE: 153</span>
            <span>FAILED SCANS: {failedEvents.length}</span>
            <span>OFFLINE QUEUE: {queuedEvents.length}</span>
          </footer>
        </section>
        <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
      </main>
    </AppChrome>
  );
}
