"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Barcode,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Keyboard,
  MapPin,
  Plus,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useDataActions, useDataState } from "../../context/DataContext";
import type { Checkpoint, MovementEvent, PermissionRequest, ScanDecision } from "../../../lib/types";
import styles from "./SecurityTerminal.module.css";

const fallbackCheckpoint: Checkpoint = {
  id: "unassigned",
  name: "Unassigned Checkpoint",
  mode: "manual",
  zone: "No zone",
  online: false,
};

const BARCODE_MAX_LENGTH = 64;
const MAX_HARDWARE_BARCODES = 4;
const BARCODE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

function validateBarcode(value: string, label: string) {
  if (!value) return `${label} is required.`;
  if (value.length > BARCODE_MAX_LENGTH) {
    return `${label} must be ${BARCODE_MAX_LENGTH} characters or fewer.`;
  }
  if (!BARCODE_PATTERN.test(value)) {
    return `${label} may contain only letters, numbers, dot, underscore, colon, slash, or hyphen.`;
  }
  return "";
}

function TerminalHeader() {
  return (
    <header className={styles.appbar}>
      <div className={styles.appbarLeft}>
        <div className={styles.brandLink} aria-label="IN / OUT security terminal">
          <span className={styles.brandMark} aria-hidden="true"><ShieldCheck /></span>
          <span>IN / OUT</span>
        </div>
        <span className={styles.appbarDivider} aria-hidden="true" />
        <div className={styles.pageIdentity}>
          <strong>Security Terminal</strong>
          <span>Primary scan service</span>
        </div>
      </div>
      <div className={styles.operator}>
        <span className={styles.operatorAvatar}>SS</span>
        <span><small>Operator</small><strong>Security Staff</strong></span>
      </div>
    </header>
  );
}

function CheckpointStrip({
  checkpoint,
  checkpoints,
  checkpointId,
  waitingCount,
  onCheckpointChange,
}: {
  checkpoint: Checkpoint;
  checkpoints: Checkpoint[];
  checkpointId: string;
  waitingCount: number;
  onCheckpointChange: (checkpointId: string) => void;
}) {
  return (
    <section className={styles.statusStrip} aria-label="Terminal status">
      <label className={styles.checkpointControl}>
        <MapPin aria-hidden="true" />
        <span>
          <small>Active checkpoint</small>
          <select value={checkpointId} onChange={(event) => onCheckpointChange(event.target.value)}>
            {checkpoints.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </span>
      </label>
      <div className={styles.statusCell}>
        <small>Waiting for permission</small>
        <strong>{waitingCount}</strong>
      </div>
    </section>
  );
}

function DecisionRegion({
  decision,
  checkpoint,
  onManualReview,
}: {
  decision: ScanDecision | null;
  checkpoint: Checkpoint;
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
    ? [["Direction", decision.event.direction], ["Time", decision.event.time], ["Event", decision.event.id], ["Scan type", decision.event.scanType]]
    : [["Checkpoint", checkpoint.name], ["Mode", checkpoint.mode]];

  return (
    <section className={styles.decision} data-result={result} aria-live="polite">
      <div className={styles.decisionBody}>
        <span className={styles.decisionIcon} aria-hidden="true">
          {result === "idle" ? <ScanLine /> : approved ? <CheckCircle2 /> : <XCircle />}
        </span>
        <div className={styles.decisionCopy}>
          <span className={styles.decisionLabel}>Scan result</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {decision && !approved ? (
          <button className={styles.reviewButton} type="button" onClick={onManualReview}>
            <RefreshCw /> Send to manual review
          </button>
        ) : null}
      </div>
      <dl className={styles.decisionFacts}>
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>
  );
}

function DecisionPopup({
  popup,
}: {
  popup: { result: "approved" | "denied" | "manual"; title: string; message: string } | null;
}) {
  if (!popup) return null;
  const icon = popup.result === "approved" ? <CheckCircle2 /> : popup.result === "denied" ? <XCircle /> : <RefreshCw />;
  return (
    <div className={styles.decisionPopup} data-result={popup.result} role="status" aria-live="assertive">
      <span className={styles.decisionPopupIcon} aria-hidden="true">{icon}</span>
      <span><strong>{popup.title}</strong><small>{popup.message}</small></span>
    </div>
  );
}

function formatMovementTime(movement: MovementEvent) {
  const timestamp = movement.createdAt
    ? Date.parse(movement.createdAt)
    : Date.parse(`${movement.date}T${movement.time}`);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function MovementLogs({ movements }: { movements: MovementEvent[] }) {
  const recentMovements = useMemo(() => movements.slice(0, 24), [movements]);

  return (
    <section className={styles.movementLogs} aria-labelledby="terminal-movement-logs-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="terminal-movement-logs-title">Movement logs</h2>
          <span>Recent terminal activity</span>
        </div>
        <span className={styles.panelCount}>{recentMovements.length}</span>
      </div>
      {recentMovements.length ? (
        <div className={styles.movementLogList}>
          {recentMovements.map((movement) => (
            <article className={styles.movementLogItem} data-result={movement.result} key={movement.id}>
              <span className={styles.movementLogIcon} aria-hidden="true">
                {movement.result === "approved" ? <CheckCircle2 /> : <XCircle />}
              </span>
              <span className={styles.movementLogCopy}>
                <strong>{movement.subjectName || movement.barcode || "Unknown subject"}</strong>
                <small>{movement.barcode || "No barcode"} · {movement.direction} · {movement.scanType === "manual" ? "Manual" : "Automatic"}</small>
              </span>
              <span className={styles.movementLogMeta}>
                <strong>{movement.result === "approved" ? "Allowed" : "Denied"}</strong>
                <small>{formatMovementTime(movement)}</small>
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.movementLogEmpty}>
          <ScanLine aria-hidden="true" />
          <strong>No movement logs yet.</strong>
          <span>Completed scans will appear here.</span>
        </div>
      )}
    </section>
  );
}

function ManualReviewQueue({ requests }: { requests: PermissionRequest[] }) {
  const reviews = useMemo(
    () => requests
      .filter((request) => request.type === "manual_override")
      .sort((left, right) => Number(right.status === "pending") - Number(left.status === "pending") || right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20),
    [requests]
  );
  const waitingCount = reviews.filter((request) => request.status === "pending").length;

  return (
    <section className={styles.reviewQueue} aria-labelledby="manual-review-queue-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="manual-review-queue-title">Manual review queue</h2>
          <span>{waitingCount ? `${waitingCount} waiting for Permission Manager` : "No reviews waiting"}</span>
        </div>
        <a className={styles.queueLink} href="/admin/permissions">Open Permission Manager <ExternalLink aria-hidden="true" /></a>
      </div>
      {reviews.length ? (
        <div className={styles.reviewQueueList}>
          {reviews.map((request) => (
            <article className={styles.reviewQueueItem} data-status={request.status} key={request.id}>
              <span className={styles.reviewQueueIcon} aria-hidden="true">
                {request.status === "pending" ? <Clock3 /> : request.status === "approved" ? <CheckCircle2 /> : <XCircle />}
              </span>
              <span className={styles.reviewQueueCopy}>
                <strong>{request.barcode || request.subjectName}</strong>
                <small>{request.checkpointId || "Checkpoint"} · {request.requester}</small>
              </span>
              <span className={styles.reviewQueueStatus}>{request.status === "pending" ? "Waiting" : request.status === "approved" ? "Allowed" : "Denied"}</span>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.reviewQueueEmpty}>
          <Barcode aria-hidden="true" />
          <strong>Nothing has been sent for manual review.</strong>
          <span>Denied scans sent to Permission Manager will appear here.</span>
        </div>
      )}
    </section>
  );
}

export function SecurityTerminal() {
  const { hardwareAssets, checkpoints, movements, permissionRequests } = useDataState();
  const { recordScan, requestBarcodeManualReview, submitPermissionRequest, refresh } = useDataActions();
  const [checkpointId, setCheckpointId] = useState("cp-main");
  const [barcode, setBarcode] = useState("");
  const [hardwareBarcodes, setHardwareBarcodes] = useState<string[]>([""]);
  const [decision, setDecision] = useState<ScanDecision | null>(null);
  const [scanError, setScanError] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [decisionPopup, setDecisionPopup] = useState<DecisionPopupState | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkpoint = checkpoints.find((item) => item.id === checkpointId) ?? checkpoints[0] ?? fallbackCheckpoint;
  const manualReviews = useMemo(() => permissionRequests.filter((request) => request.type === "manual_override"), [permissionRequests]);
  const waitingReviews = manualReviews.filter((request) => request.status === "pending");

  useEffect(() => () => {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
  }, []);

  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function showDecisionPopup(result: "approved" | "denied" | "manual", message: string) {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    setDecisionPopup({ result, title: result === "approved" ? "Access approved" : result === "denied" ? "Access denied" : "Sent for manual review", message });
    popupTimerRef.current = setTimeout(() => setDecisionPopup(null), 3000);
  }

  async function runScan(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalizedBarcode = barcode.trim();
    const carrierError = validateBarcode(normalizedBarcode, "Carrier barcode");
    if (carrierError) {
      setScanError(carrierError);
      setDecision(null);
      barcodeInputRef.current?.focus();
      return;
    }

    const requestedHardwareBarcodes = hardwareBarcodes.map((value) => value.trim().toLowerCase()).filter(Boolean);
    const hardwareError = requestedHardwareBarcodes.map((value, index) => validateBarcode(value, `Hardware barcode ${index + 1}`)).find(Boolean);
    if (hardwareError) {
      setScanError(hardwareError);
      setDecision(null);
      return;
    }
    if (requestedHardwareBarcodes.length > MAX_HARDWARE_BARCODES) {
      setScanError(`No more than ${MAX_HARDWARE_BARCODES} hardware barcodes may be scanned at once.`);
      setDecision(null);
      return;
    }

    setScanError("");
    setDecision(null);
    setIsScanning(true);
    try {
      const hardwareFromSeries = requestedHardwareBarcodes.map((value) => hardwareAssets.find((asset) => asset.barcode.toLowerCase() === value));
      const unresolvedBarcode = requestedHardwareBarcodes.find((_, index) => !hardwareFromSeries[index]);
      if (unresolvedBarcode) {
        const localDecision: ScanDecision = {
          event: {
            id: `unregistered-${Date.now()}`,
            date: new Date().toISOString().slice(0, 10),
            time: new Date().toLocaleTimeString(),
            checkpointId: checkpoint.id,
            checkpoint: checkpoint.name,
            direction: checkpoint.mode === "exit" ? "exit" : "entry",
            subjectId: "unregistered",
            subjectName: "Unregistered barcode",
            subjectType: "visitor",
            barcode: unresolvedBarcode,
            result: "denied",
            reason: "Hardware barcode is not registered.",
            denialCode: "barcode_not_registered",
            scanType: "auto",
            syncState: "synced",
            hardwareIds: [],
          },
          carriedHardware: [],
        };
        setDecision(localDecision);
        showDecisionPopup("denied", "Hardware barcode is not registered.");
        return;
      }

      const seriesHardwareIds = hardwareFromSeries.flatMap((asset) => asset ? [asset.id] : []);
      const result = await recordScan({ barcode: normalizedBarcode, checkpointId: checkpoint.id, selectedHardwareIds: [...new Set(seriesHardwareIds)], online: true, scanType: "auto" });
      setDecision(result.decision);
      showDecisionPopup(result.decision.event.result, result.decision.event.reason && result.decision.event.reason !== "-" ? result.decision.event.reason : `${result.decision.event.subjectName} may proceed.`);
      setHardwareBarcodes([""]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to record scan.";
      setScanError(message);
      if (/barcode not registered/i.test(message)) showDecisionPopup("denied", "Barcode is not registered.");
    } finally {
      setIsScanning(false);
    }
  }

  async function requestAdminOverride() {
    if (!decision) return;
    try {
      if (!decision.subject) {
        await requestBarcodeManualReview({ barcode: decision.event.barcode, checkpointId: checkpoint.id, direction: decision.event.direction, eventId: decision.event.id });
      } else {
        await submitPermissionRequest({
          type: "manual_override",
          subjectId: decision.subject.id,
          subjectName: decision.subject.name,
          requester: "Terminal Operator",
          purpose: `Requested manual override for denied ${decision.event.direction}`,
          requestedZones: [checkpoint.zone],
          validFrom: new Date().toISOString(),
          validTo: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          checkpointId: checkpoint.id,
          direction: decision.event.direction,
          eventId: decision.event.id,
          barcode: decision.event.barcode,
        });
      }
      showDecisionPopup("manual", "The barcode is waiting for Allow or Deny in Permission Manager.");
      setScanError("");
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Unable to request manual review.");
    }
  }

  return (
    <main className={styles.page}>
      <TerminalHeader />
      <CheckpointStrip checkpoint={checkpoint} checkpoints={checkpoints} checkpointId={checkpoint.id} waitingCount={waitingReviews.length} onCheckpointChange={setCheckpointId} />
      <div className={styles.workspace}>
        <MovementLogs movements={movements} />
        <div className={styles.mainStage}>
          <section className={styles.scanSection} aria-labelledby="scan-title">
            <div className={styles.scanHeading}>
              <span className={styles.scanHeadingIcon} aria-hidden="true"><Barcode /></span>
              <span><h1 id="scan-title">Scan a barcode</h1><small>{checkpoint.name}</small></span>
            </div>
            <form className={styles.scanForm} onSubmit={runScan} noValidate>
              <div className={styles.barcodeSeries}>
                <label className={styles.scanInput}>
                  <span className={styles.barcodeKind}>Carrier</span>
                  <input ref={barcodeInputRef} autoComplete="off" value={barcode} aria-invalid={Boolean(scanError)} maxLength={BARCODE_MAX_LENGTH} inputMode="text" pattern="[A-Za-z0-9._:/-]+" title="Use letters, numbers, dot, underscore, colon, slash, or hyphen (maximum 64 characters)." placeholder="Employee or visitor barcode" onChange={(event) => setBarcode(event.target.value)} />
                  <Keyboard aria-hidden="true" />
                </label>
                {hardwareBarcodes.map((value, index) => (
                  <label className={styles.scanInput} key={`hardware-barcode-${index}`}>
                    <span className={styles.barcodeKind}>Item {index + 1}</span>
                    <input autoComplete="off" value={value} placeholder="Optional hardware barcode" aria-label={`Hardware barcode ${index + 1}`} maxLength={BARCODE_MAX_LENGTH} inputMode="text" pattern="[A-Za-z0-9._:/-]+" title="Use letters, numbers, dot, underscore, colon, slash, or hyphen (maximum 64 characters)." onChange={(event) => setHardwareBarcodes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
                    {hardwareBarcodes.length > 1 ? <button type="button" className={styles.removeBarcode} aria-label={`Remove hardware barcode ${index + 1}`} onClick={() => setHardwareBarcodes((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></button> : null}
                  </label>
                ))}
                <button type="button" className={styles.addBarcode} disabled={hardwareBarcodes.length >= MAX_HARDWARE_BARCODES} onClick={() => setHardwareBarcodes((current) => [...current, ""])}><Plus /> Add hardware barcode</button>
              </div>
              <button className={styles.scanButton} type="submit" disabled={isScanning}><ScanLine /> {isScanning ? "Scanning" : "Run scan"}</button>
            </form>
            {scanError ? <p className={styles.scanError} role="alert">{scanError}</p> : null}
          </section>
          <DecisionRegion decision={decision} checkpoint={checkpoint} onManualReview={() => void requestAdminOverride()} />
          <DecisionPopup popup={decisionPopup} />
        </div>
        <ManualReviewQueue requests={permissionRequests} />
      </div>
    </main>
  );
}

type DecisionPopupState = {
  result: "approved" | "denied" | "manual";
  title: string;
  message: string;
};
