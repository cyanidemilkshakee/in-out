"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Barcode,
  Check,
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  Keyboard,
  MapPin,
  Package,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useDataActions, useDataState } from "../../context/DataContext";
import type {
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  ScanDecision,
  SubjectRecord,
} from "../../lib/types";
import { ToastRegion, type ToastMessage } from "../ToastRegion";
import styles from "./SecurityTerminal.module.css";

const fallbackCheckpoint: Checkpoint = {
  id: "unassigned",
  name: "Unassigned Checkpoint",
  mode: "manual",
  zone: "No zone",
  online: false,
};

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function getSubjectDetails(subject: SubjectRecord) {
  if ("type" in subject) {
    return [
      ["Access", subject.accessLevel],
      ["Status", subject.status.replace("_", " ")],
      [subject.type === "employee" ? "Department" : "Host", subject.department ?? subject.host ?? "-"],
      ["Inside", subject.inside ? "Yes" : "No"],
    ];
  }

  return [
    ["Category", subject.category],
    ["Owner", subject.owner],
    ["Status", subject.status],
    ["Inside", subject.inside ? "Yes" : "No"],
  ];
}

function TerminalHeader({
  online,
  onToggleOnline,
}: {
  online: boolean;
  onToggleOnline: () => void;
}) {
  return (
    <header className={styles.appbar}>
      <div className={styles.appbarLeft}>
        <Link className={styles.brandLink} href="/admin" aria-label="Open admin dashboard">
          <span className={styles.brandMark} aria-hidden="true">
            <ShieldCheck />
          </span>
          <span>IN / OUT</span>
        </Link>
        <span className={styles.appbarDivider} aria-hidden="true" />
        <div className={styles.pageIdentity}>
          <strong>Security Terminal</strong>
          <span>Checkpoint operations</span>
        </div>
      </div>

      <div className={styles.headerActions}>
        <Link className={styles.adminLink} href="/admin">
          <ShieldCheck />
          <span>Admin Console</span>
        </Link>
        <button
          className={styles.networkButton}
          type="button"
          aria-pressed={online}
          onClick={onToggleOnline}
        >
          {online ? <Wifi /> : <WifiOff />}
          <span>{online ? "Online" : "Offline"}</span>
        </button>
        <div className={styles.operator}>
          <span className={styles.operatorAvatar}>SS</span>
          <span>
            <small>Operator</small>
            <strong>Security Staff</strong>
          </span>
        </div>
      </div>
    </header>
  );
}

function StatusStrip({
  checkpoint,
  checkpoints,
  checkpointId,
  queuedCount,
  conflictCount,
  onCheckpointChange,
}: {
  checkpoint: Checkpoint;
  checkpoints: Checkpoint[];
  checkpointId: string;
  queuedCount: number;
  conflictCount: number;
  onCheckpointChange: (checkpointId: string) => void;
}) {
  return (
    <section className={styles.statusStrip} aria-label="Terminal status">
      <label className={styles.checkpointControl}>
        <MapPin aria-hidden="true" />
        <span>
          <small>Active checkpoint</small>
          <select
            value={checkpointId}
            onChange={(event) => onCheckpointChange(event.target.value)}
          >
            {checkpoints.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </span>
      </label>
      <div className={styles.statusCell}>
        <small>Zone</small>
        <strong>{checkpoint.zone}</strong>
      </div>
      <div className={styles.statusCell}>
        <small>Offline queue</small>
        <strong>{queuedCount}</strong>
      </div>
      <div className={styles.statusCell}>
        <small>Conflicts</small>
        <strong className={conflictCount > 0 ? styles.alertText : undefined}>
          {conflictCount}
        </strong>
      </div>
    </section>
  );
}

function DecisionRegion({
  decision,
  checkpoint,
  online,
  hardwareCount,
  onManualReview,
}: {
  decision: ScanDecision | null;
  checkpoint: Checkpoint;
  online: boolean;
  hardwareCount: number;
  onManualReview: () => void;
}) {
  const result = decision?.event.result ?? "idle";
  const approved = result === "approved";
  const title = decision
    ? approved
      ? `${decision.event.direction === "entry" ? "Entry" : "Exit"} allowed`
      : "Access denied"
    : "Ready for scan";
  const description = decision
    ? decision.event.reason && decision.event.reason !== "-"
      ? decision.event.reason
      : decision.event.subjectName
    : `Waiting at ${checkpoint.name}`;

  const facts = decision
    ? [
        ["Direction", decision.event.direction],
        ["Time", decision.event.time],
        ["Event", decision.event.id],
        ["Sync", decision.event.syncState],
      ]
    : [
        ["Checkpoint", checkpoint.name],
        ["Mode", checkpoint.mode],
        ["Hardware", String(hardwareCount)],
        ["Network", online ? "online" : "offline"],
      ];

  return (
    <section className={styles.decision} data-result={result} aria-live="polite">
      <div className={styles.decisionBody}>
        <span className={styles.decisionIcon} aria-hidden="true">
          {result === "idle" ? (
            <ScanLine />
          ) : approved ? (
            <CheckCircle2 />
          ) : (
            <XCircle />
          )}
        </span>
        <div className={styles.decisionCopy}>
          <span className={styles.decisionLabel}>Scan decision</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {decision ? (
          <button className={styles.reviewButton} type="button" onClick={onManualReview}>
            <RefreshCw />
            Send to manual review
          </button>
        ) : null}
      </div>
      <dl className={styles.decisionFacts}>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ActivityTable({ events }: { events: MovementEvent[] }) {
  return (
    <section className={styles.activitySection} aria-labelledby="recent-activity-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="recent-activity-title">Recent activity</h2>
          <span>{events.length} latest movements</span>
        </div>
      </div>
      <div className={styles.activityTableWrap}>
        <table className={styles.activityTable}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Subject / ID</th>
              <th>Type</th>
              <th>Direction</th>
              <th>Checkpoint</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.time}</td>
                <td>
                  <strong>{event.subjectName}</strong>
                  <span>{event.barcode}</span>
                </td>
                <td>{event.subjectType}</td>
                <td>
                  <span className={styles.direction} data-direction={event.direction}>
                    {event.direction === "entry" ? <ArrowDownRight /> : <ArrowUpRight />}
                    {event.direction}
                  </span>
                </td>
                <td>{event.checkpoint}</td>
                <td>
                  <span className={styles.result} data-result={event.result}>
                    {event.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SubjectSection({
  subject,
  decision,
}: {
  subject?: SubjectRecord;
  decision: ScanDecision | null;
}) {
  return (
    <section className={styles.railSection} aria-labelledby="subject-title">
      <div className={styles.railHeading}>
        <h2 id="subject-title">Subject</h2>
        {subject ? <span>{"type" in subject ? subject.type : "hardware"}</span> : null}
      </div>
      {subject ? (
        <>
          <div className={styles.subjectIdentity}>
            <span className={styles.subjectAvatar}>{getInitials(subject.name)}</span>
            <span>
              <strong>{subject.name}</strong>
              <small>{subject.barcode}</small>
            </span>
          </div>
          <dl className={styles.subjectDetails}>
            {getSubjectDetails(subject).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {decision ? (
            <div className={styles.subjectEvent}>
              <Barcode />
              <span>
                <small>Latest decision</small>
                <strong>{decision.event.result}</strong>
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className={styles.emptySubject}>
          <UserRound />
          <span>
            <strong>Awaiting barcode</strong>
            <small>No active subject</small>
          </span>
        </div>
      )}
    </section>
  );
}

function HardwareSection({
  assets,
  selectedIds,
  onToggle,
}: {
  assets: HardwareAsset[];
  selectedIds: string[];
  onToggle: (assetId: string) => void;
}) {
  return (
    <section className={`${styles.railSection} ${styles.hardwareSection}`} aria-labelledby="hardware-title">
      <div className={styles.railHeading}>
        <h2 id="hardware-title">Carried hardware</h2>
        <span>{selectedIds.length} selected</span>
      </div>
      <div className={styles.hardwareList}>
        {assets.map((asset) => {
          const selected = selectedIds.includes(asset.id);
          return (
            <label className={styles.hardwareRow} key={asset.id}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggle(asset.id)}
              />
              <span className={styles.checkBox} aria-hidden="true">
                {selected ? <Check /> : null}
              </span>
              <Package aria-hidden="true" />
              <span>
                <strong>{asset.name}</strong>
                <small>{asset.barcode} / {asset.owner}</small>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function SyncSection({
  online,
  queuedEvents,
  conflictEvents,
  onSync,
  onResolve,
}: {
  online: boolean;
  queuedEvents: MovementEvent[];
  conflictEvents: MovementEvent[];
  onSync: () => void;
  onResolve: () => void;
}) {
  return (
    <section className={`${styles.railSection} ${styles.syncSection}`} aria-labelledby="sync-title">
      <div className={styles.railHeading}>
        <h2 id="sync-title">Sync status</h2>
        <span>{online ? "Connected" : "Local mode"}</span>
      </div>
      <div className={styles.syncRows}>
        <div>
          <CloudUpload />
          <span>Offline queue</span>
          <strong>{queuedEvents.length}</strong>
        </div>
        <div>
          <CircleAlert />
          <span>Conflicts</span>
          <strong>{conflictEvents.length}</strong>
        </div>
      </div>
      <div className={styles.syncActions}>
        <button
          className={styles.syncButton}
          type="button"
          disabled={!online || queuedEvents.length === 0}
          onClick={onSync}
        >
          <CloudUpload />
          Sync queue
        </button>
        {conflictEvents.length > 0 ? (
          <button
            className={styles.resolveButton}
            type="button"
            disabled={!online}
            onClick={onResolve}
          >
            <AlertTriangle />
            Resolve conflicts
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function SecurityTerminal() {
  const { people, hardwareAssets, movements, checkpoints } = useDataState();
  const { recordScan, saveMovement, syncMovements, resolveMovementConflicts } =
    useDataActions();
  const [checkpointId, setCheckpointId] = useState("cp-main");
  const [online, setOnline] = useState(true);
  const [barcode, setBarcode] = useState("test2");
  const [selectedHardwareIds, setSelectedHardwareIds] = useState<string[]>([]);
  const [decision, setDecision] = useState<ScanDecision | null>(null);
  const [scanError, setScanError] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const checkpoint =
    checkpoints.find((item) => item.id === checkpointId) ??
    checkpoints[0] ??
    fallbackCheckpoint;

  const { queuedEvents, conflictEvents } = useMemo(() => {
    const queued: MovementEvent[] = [];
    const conflicts: MovementEvent[] = [];
    for (const event of movements) {
      if (event.syncState === "queued") queued.push(event);
      if (event.syncState === "conflict") conflicts.push(event);
    }
    return { queuedEvents: queued, conflictEvents: conflicts };
  }, [movements]);

  const recentEvents = movements.slice(0, 6);

  function showToast(message: string) {
    setToast({ id: Date.now(), message });
  }

  async function runScan(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalizedBarcode = barcode.trim();
    if (!normalizedBarcode) {
      setScanError("Enter or scan a barcode.");
      return;
    }

    setIsScanning(true);
    try {
      const result = await recordScan({
        barcode: normalizedBarcode,
        checkpointId: checkpoint.id,
        selectedHardwareIds,
        online,
        scanType: "manual",
      });
      setDecision(result.decision);
      setScanError("");
      showToast(`${result.decision.event.subjectName}: ${result.decision.event.result}.`);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Unable to record scan.");
    } finally {
      setIsScanning(false);
    }
  }

  function toggleHardware(assetId: string) {
    setSelectedHardwareIds((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId]
    );
  }

  async function sendToManualReview() {
    if (!decision) return;
    const saved = await saveMovement({
      ...decision.event,
      result: "denied",
      reason: "Security escalated for manual review",
      syncState: online ? "synced" : "queued",
    });
    setDecision({ ...decision, event: saved });
    showToast("Scan sent to manual review.");
  }

  async function syncQueue() {
    if (!online) return;
    await syncMovements(queuedEvents.map((event) => event.id));
    showToast("Offline queue processed.");
  }

  async function resolveConflicts() {
    if (!online) return;
    await resolveMovementConflicts(conflictEvents.map((event) => event.id));
    showToast("Movement conflicts resolved.");
  }

  return (
    <main className={styles.page}>
      <TerminalHeader online={online} onToggleOnline={() => setOnline((value) => !value)} />
      <StatusStrip
        checkpoint={checkpoint}
        checkpoints={checkpoints}
        checkpointId={checkpoint.id}
        queuedCount={queuedEvents.length}
        conflictCount={conflictEvents.length}
        onCheckpointChange={setCheckpointId}
      />

      <div className={styles.workspace}>
        <div className={styles.mainStage}>
          <section className={styles.scanSection} aria-labelledby="scan-title">
            <div className={styles.scanHeading}>
              <span className={styles.scanHeadingIcon} aria-hidden="true">
                <Barcode />
              </span>
              <span>
                <h1 id="scan-title">Scan a barcode</h1>
                <small>{checkpoint.name}</small>
              </span>
            </div>
            <form className={styles.scanForm} onSubmit={runScan}>
              <label className={styles.scanInput}>
                <span className="sr-only">Barcode or ID</span>
                <input
                  autoFocus
                  autoComplete="off"
                  value={barcode}
                  aria-invalid={Boolean(scanError)}
                  placeholder="Barcode or ID"
                  onChange={(event) => setBarcode(event.target.value)}
                />
                <Keyboard aria-hidden="true" />
              </label>
              <button className={styles.scanButton} type="submit" disabled={isScanning}>
                <ScanLine />
                {isScanning ? "Scanning" : "Run scan"}
              </button>
            </form>
            {scanError ? <p className={styles.scanError}>{scanError}</p> : null}
          </section>

          <DecisionRegion
            decision={decision}
            checkpoint={checkpoint}
            online={online}
            hardwareCount={selectedHardwareIds.length}
            onManualReview={() => void sendToManualReview()}
          />

          <ActivityTable events={recentEvents} />
        </div>

        <aside className={styles.rightRail} aria-label="Scan context">
          <SubjectSection subject={decision?.subject} decision={decision} />
          <HardwareSection
            assets={hardwareAssets}
            selectedIds={selectedHardwareIds}
            onToggle={toggleHardware}
          />
          <SyncSection
            online={online}
            queuedEvents={queuedEvents}
            conflictEvents={conflictEvents}
            onSync={() => void syncQueue()}
            onResolve={() => void resolveConflicts()}
          />
        </aside>
      </div>

      <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}
