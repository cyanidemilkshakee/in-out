"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, ArrowRight, Barcode, Check, ChevronDown, Clock3, CloudOff, Loader2, Moon, Plus, ScanLine, Sun, UserRound, X } from "lucide-react";
import { useDataActions, useDataState } from "../../context/DataContext";
import { useAdminTheme } from "../../hooks/useAdminTheme";
import type { PermissionRequest, RecordScanInput, ScanDecision } from "../../../lib/types";
import { DataServiceError } from "../../../services/httpDataService";
import {
  cacheTerminalConfig,
  enqueueTerminalScan,
  listQueuedTerminalScans,
  loadCachedTerminalConfig,
  recordQueuedScanFailure,
  removeQueuedTerminalScan,
  queuedScanInput,
  type CachedTerminalConfig,
  type QueuedTerminalScan,
} from "../../lib/offlineTerminalQueue";
import { AccountActions } from "../AccountActions";
import { formatTerminalTime, PendingPermissions, TerminalActivity } from "./TerminalPanels";
import styles from "./SecurityTerminal.module.css";

const BARCODE_MAX_LENGTH = 64;
const MAX_HARDWARE_BARCODES = 4;
const BARCODE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

function validateBarcode(value: string, label: string) {
  if (!value) return `${label} is required.`;
  if (value.length > BARCODE_MAX_LENGTH) return `${label} must be ${BARCODE_MAX_LENGTH} characters or fewer.`;
  if (!BARCODE_PATTERN.test(value)) return `${label} may contain only letters, numbers, dot, underscore, colon, slash, or hyphen.`;
  return "";
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isRecoverableConnectionFailure(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (error instanceof TypeError) return true;
  return error instanceof DataServiceError && [502, 503, 504].includes(error.status);
}

export function SecurityTerminal() {
  const { hardwareAssets, checkpoints, movements, permissionRequests, adminAvailability, error, isLoading } = useDataState();
  const { recordScan, requestBarcodeManualReview, submitPermissionRequest, acknowledgePermissionRequest, refresh } = useDataActions();
  const theme = useAdminTheme();
  const [checkpointId, setCheckpointId] = useState("cp-main");
  const [manualDirection, setManualDirection] = useState<"entry" | "exit">("entry");
  const [barcode, setBarcode] = useState("");
  const [hardwareBarcodes, setHardwareBarcodes] = useState<string[]>([]);
  const [decision, setDecision] = useState<ScanDecision | null>(null);
  const [submittedReview, setSubmittedReview] = useState<PermissionRequest | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [scanError, setScanError] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [cachedTerminalConfig, setCachedTerminalConfig] = useState<CachedTerminalConfig | null>(null);
  const [queuedScans, setQueuedScans] = useState<QueuedTerminalScan[]>([]);
  const [latestQueuedScan, setLatestQueuedScan] = useState<QueuedTerminalScan | null>(null);
  const [isQueueSyncing, setIsQueueSyncing] = useState(false);
  const [queueStatus, setQueueStatus] = useState("");
  const [networkOnline, setNetworkOnline] = useState(true);
  const [scanFeedback, setScanFeedback] = useState<{ outcome: "approved" | "denied"; key: number } | null>(null);
  const [acknowledgingRequestId, setAcknowledgingRequestId] = useState<string | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const queueSyncRef = useRef(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountRef = useRef<HTMLDetailsElement>(null);

  const terminalCheckpoints = checkpoints.length ? checkpoints : cachedTerminalConfig?.checkpoints ?? [];
  const terminalHardwareAssets = hardwareAssets.length ? hardwareAssets : cachedTerminalConfig?.hardwareAssets ?? [];
  const checkpoint = terminalCheckpoints.find((item) => item.id === checkpointId) ?? terminalCheckpoints[0];
  const checkpointMovements = useMemo(() => movements.filter((movement) => movement.checkpointId === checkpoint?.id), [movements, checkpoint?.id]);
  const checkpointReviews = useMemo(() => permissionRequests.filter((request) => request.type === "manual_override" && request.checkpointId === checkpoint?.id), [permissionRequests, checkpoint?.id]);
  const manualApprovalRequests = useMemo(() => {
    if (!submittedReview || checkpointReviews.some((request) => request.id === submittedReview.id)) return checkpointReviews;
    return [submittedReview, ...checkpointReviews];
  }, [checkpointReviews, submittedReview]);
  const review = (decision && checkpointReviews.find((request) => request.id === submittedReview?.id || request.eventId === decision.event.id)) || submittedReview;
  const result = isScanning ? "scanning" : latestQueuedScan ? "queued" : review?.status === "pending" ? "pending" : review?.status ?? decision?.event.result ?? "idle";
  const direction = decision?.event.direction === "exit" ? "Exit" : "Entry";
  const busy = isScanning || isReviewing;
  const estimatedAdminReturn = adminAvailability?.status === "offline" && adminAvailability.availableAt
    ? formatTerminalTime(adminAvailability.availableAt)
    : null;
  const title = result === "scanning" ? "Checking access" : result === "queued" ? "Scan queued for verification" : result === "pending" ? "Awaiting approval" : result === "approved" ? `${direction} allowed` : result === "denied" ? "Access denied" : "Ready to scan";
  const description = result === "scanning" ? "Verifying this barcode…" : result === "queued" ? "This scan is stored on this terminal and will be sent when the connection returns. Do not grant access until the server confirms it." : result === "pending" ? estimatedAdminReturn ? `An administrator is offline. This permission may be picked up around ${estimatedAdminReturn}.` : "An administrator is reviewing this permission." : review?.status === "approved" ? "Permission approved. You may proceed." : review?.status === "denied" ? "The administrator declined this request." : result === "denied" ? "" : decision ? decision.event.reason && decision.event.reason !== "-" ? decision.event.reason : "Access verified. You may proceed." : "The access decision will appear here.";

  const refreshQueuedScans = useCallback(async () => {
    const pending = await listQueuedTerminalScans();
    setQueuedScans(pending);
    return pending;
  }, []);

  const queueScanForLater = useCallback(async (
    input: RecordScanInput,
    idempotencyKey?: string,
  ) => {
    const queued = await enqueueTerminalScan(input, idempotencyKey);
    setLatestQueuedScan(queued);
    await refreshQueuedScans();
    setQueueStatus("Scan queued on this device. It will be verified after reconnection.");
    setBarcode("");
    setHardwareBarcodes([]);
  }, [refreshQueuedScans]);

  const synchronizeQueuedScans = useCallback(async () => {
    if (queueSyncRef.current) return;
    if (typeof navigator === "undefined" || !navigator.onLine) {
      setQueueStatus("Waiting for a network connection before syncing queued scans.");
      return;
    }

    queueSyncRef.current = true;
    setIsQueueSyncing(true);
    try {
      const pending = await listQueuedTerminalScans();
      let synced = 0;
      for (const queued of pending) {
        try {
          await recordScan(queuedScanInput(queued), queued.idempotencyKey);
          await removeQueuedTerminalScan(queued.idempotencyKey);
          setLatestQueuedScan((current) => current?.idempotencyKey === queued.idempotencyKey ? null : current);
          synced += 1;
        } catch (syncError) {
          await recordQueuedScanFailure(queued.idempotencyKey, messageFor(syncError, "Unable to sync queued scan."));
          setQueueStatus(`Sync paused: ${messageFor(syncError, "Unable to sync queued scan.")}`);
          break;
        }
      }
      const remaining = await refreshQueuedScans();
      if (!remaining.length && synced) {
        setQueueStatus(`${synced} queued scan${synced === 1 ? "" : "s"} verified and synced.`);
        await refresh();
      } else if (!pending.length) {
        setQueueStatus("There are no queued scans to sync.");
      }
    } catch (queueError) {
      setQueueStatus(messageFor(queueError, "Unable to access the offline scan queue."));
    } finally {
      queueSyncRef.current = false;
      setIsQueueSyncing(false);
    }
  }, [recordScan, refresh, refreshQueuedScans]);

  useEffect(() => { barcodeInputRef.current?.focus(); }, []);
  useEffect(() => {
    void Promise.all([loadCachedTerminalConfig(), refreshQueuedScans()])
      .then(([cached]) => setCachedTerminalConfig(cached))
      .catch((queueError) => setQueueStatus(messageFor(queueError, "Unable to load offline terminal data.")));
  }, [refreshQueuedScans]);
  useEffect(() => {
    if (!checkpoints.length) return;
    void cacheTerminalConfig({ checkpoints, hardwareAssets })
      .catch((queueError) => setQueueStatus(messageFor(queueError, "Unable to cache terminal configuration.")));
  }, [checkpoints, hardwareAssets]);
  useEffect(() => {
    const updateNetworkState = () => setNetworkOnline(navigator.onLine);
    updateNetworkState();
    window.addEventListener("online", updateNetworkState);
    window.addEventListener("offline", updateNetworkState);
    return () => {
      window.removeEventListener("online", updateNetworkState);
      window.removeEventListener("offline", updateNetworkState);
    };
  }, []);
  useEffect(() => {
    if (networkOnline && queuedScans.length) void synchronizeQueuedScans();
  }, [networkOnline, queuedScans.length, synchronizeQueuedScans]);
  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  function focusBarcode() {
    requestAnimationFrame(() => { barcodeInputRef.current?.focus(); barcodeInputRef.current?.select(); });
  }

  function showScanFeedback(outcome: "approved" | "denied") {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setScanFeedback({ outcome, key: Date.now() });
    feedbackTimerRef.current = setTimeout(() => setScanFeedback(null), 2400);
  }

  function resetScan() {
    setLatestQueuedScan(null);
    setDecision(null);
    setSubmittedReview(null);
    setReviewNote("");
    setScanError("");
    setScanFeedback(null);
    setBarcode("");
    setHardwareBarcodes([]);
    focusBarcode();
  }

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.adminTheme = next;
    window.localStorage.setItem("inout-admin-theme", next);
  }

  async function runScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || !checkpoint) return;
    setLatestQueuedScan(null);
    setDecision(null);
    setSubmittedReview(null);
    setReviewNote("");
    setScanFeedback(null);
    const normalizedBarcode = barcode.trim();
    const validationError = validateBarcode(normalizedBarcode, "Barcode");
    if (validationError) { setScanError(validationError); focusBarcode(); return; }
    const requestedHardware = hardwareBarcodes.map((value) => value.trim().toLowerCase()).filter(Boolean);
    const hardwareError = requestedHardware.map((value, index) => validateBarcode(value, `Hardware barcode ${index + 1}`)).find(Boolean);
    if (hardwareError) { setScanError(hardwareError); return; }
    const assets = requestedHardware.map((value) => terminalHardwareAssets.find((asset) => asset.barcode.toLowerCase() === value));
    const unknown = requestedHardware.find((_, index) => !assets[index]);
    if (unknown) {
      setScanError(`Hardware barcode "${unknown}" is not registered. Remove it or register the asset before scanning.`);
      return;
    }
    busyRef.current = true;
    setIsScanning(true);
    setScanError("");
    try {
      const input: RecordScanInput = {
        barcode: normalizedBarcode, checkpointId: checkpoint.id,
        selectedHardwareIds: [...new Set(assets.flatMap((asset) => asset ? [asset.id] : []))],
        ...(checkpoint.mode === "manual" ? { direction: manualDirection } : {}),
        online: true, scanType: "auto",
      };
      const idempotencyKey = crypto.randomUUID();
      if (!networkOnline) {
        await queueScanForLater({ ...input, capturedOfflineAt: new Date().toISOString() }, idempotencyKey);
        return;
      }
      let response;
      try {
        response = await recordScan(input, idempotencyKey);
      } catch (cause) {
        if (!isRecoverableConnectionFailure(cause)) throw cause;
        await queueScanForLater(input, idempotencyKey);
        return;
      }
      setDecision(response.decision);
      if (response.decision.event.result === "approved" || response.decision.event.result === "denied") {
        showScanFeedback(response.decision.event.result);
      }
      setBarcode("");
      setHardwareBarcodes([]);
    } catch (cause) {
      setScanError(messageFor(cause, "Unable to record scan. Please try again."));
    } finally {
      busyRef.current = false;
      setIsScanning(false);
      focusBarcode();
    }
  }

  async function requestReview() {
    if (!decision || review || busyRef.current) return;
    busyRef.current = true;
    setIsReviewing(true);
    setScanError("");
    try {
      const operatorNote = reviewNote.trim();
      if (!operatorNote) {
        setScanError("Add a note before requesting permission.");
        return;
      }
      const source = {
        barcode: decision.event.barcode,
        checkpointId: decision.event.checkpointId,
        direction: decision.event.direction,
        eventId: decision.event.id,
        operatorNote,
      };
      const request = decision.subject ? await submitPermissionRequest({
        ...source, type: "manual_override", subjectId: decision.subject.id,
        subjectName: decision.subject.name, requester: "Terminal Operator",
        purpose: `Requested permission for denied ${decision.event.direction}`,
        requestedZones: terminalCheckpoints.filter((item) => item.id === decision.event.checkpointId).map((item) => item.zone),
        validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }) : await requestBarcodeManualReview(source);
      setSubmittedReview(request);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : "Unable to request permission. Please try again.");
    } finally {
      busyRef.current = false;
      setIsReviewing(false);
    }
  }

  async function acknowledgeReview(requestId: string) {
    setAcknowledgingRequestId(requestId);
    setScanError("");
    try {
      await acknowledgePermissionRequest(requestId);
    } catch (cause) {
      setScanError(messageFor(cause, "Unable to acknowledge this decision. Please try again."));
    } finally {
      setAcknowledgingRequestId(null);
    }
  }

  return (
    <main className={styles.page}>
      {scanFeedback && <div key={scanFeedback.key} className={styles.scanFeedback} data-outcome={scanFeedback.outcome} role="status" aria-live="assertive" aria-atomic="true">
        <div className={styles.feedbackBurst} aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <span key={index} className={`${styles.particle} ${styles[`particle${index}`]}`} />)}</div>
        <div className={styles.feedbackMessage}>
          <span aria-hidden="true">{scanFeedback.outcome === "approved" ? <Check /> : <X />}</span>
          <strong>{scanFeedback.outcome === "approved" ? "Access granted" : "Access denied"}</strong>
          <p>{scanFeedback.outcome === "approved" ? "Proceed through the checkpoint." : "Do not allow entry or exit."}</p>
        </div>
      </div>}
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <span className={styles.brand}>IN / OUT<span className={styles.brandDivider} aria-hidden="true" /><span>Security</span></span>
          <div className={styles.headerActions}>
            <button className={styles.iconButton} type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}>
              {theme === "light" ? <Moon /> : <Sun />}
            </button>
            <details className={styles.account} ref={accountRef} onKeyDown={(event) => { if (event.key === "Escape" && accountRef.current) { accountRef.current.open = false; accountRef.current.querySelector("summary")?.focus(); } }}>
              <summary aria-label="Account menu"><UserRound aria-hidden="true" /><ChevronDown aria-hidden="true" /></summary>
              <div className={styles.accountMenu}><AccountActions /></div>
            </details>
          </div>
        </header>

        <section className={styles.heading} aria-labelledby="terminal-title">
          <div className={styles.headingCopy}><h1 id="terminal-title">Security terminal</h1><p>Check access. Keep things moving.</p></div>
          <label className={styles.checkpointControl}>
            <span>Checkpoint</span>
            <span className={styles.selectWrap}>
              <select aria-label="Checkpoint" value={checkpoint?.id ?? ""} disabled={busy || !terminalCheckpoints.length} onChange={(event) => { setCheckpointId(event.target.value); setManualDirection("entry"); resetScan(); }}>
                {!terminalCheckpoints.length && <option value="">{isLoading ? "Loading checkpoints…" : "Connect once to cache terminal setup"}</option>}
                {terminalCheckpoints.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select><ChevronDown aria-hidden="true" />
            </span>
          </label>
        </section>

        {error && !terminalCheckpoints.length && <div className={styles.connectionError} role="alert"><span>Unable to update terminal data. {error}</span><button type="button" onClick={() => void refresh()} disabled={isLoading}>Retry</button></div>}
        <div className={styles.queueStatus} data-online={networkOnline}>
          <span>{networkOnline ? "Online" : "Offline"}</span>
          <p>{queuedScans.length ? `${queuedScans.length} scan${queuedScans.length === 1 ? "" : "s"} queued on this device.` : "No scans waiting to sync."}</p>
          {queuedScans.length > 0 && <button type="button" onClick={() => void synchronizeQueuedScans()} disabled={!networkOnline || isQueueSyncing}>{isQueueSyncing ? "Syncing…" : "Sync queued scans"}</button>}
          {queueStatus && <small role="status">{queueStatus}</small>}
        </div>

        <div className={styles.scanWorkspace}>
          <section className={styles.scanSection} aria-labelledby="scan-title">
            <h2 id="scan-title" className={styles.srOnly}>Scan barcode</h2>
            <form onSubmit={runScan} noValidate className={styles.scanForm}>
              {checkpoint?.mode === "manual" && <div className={styles.directionChoice} role="group" aria-label="Scan direction">
                <button type="button" disabled={busy} aria-pressed={manualDirection === "entry"} onClick={() => setManualDirection("entry")}><ArrowDownLeft />Entry</button>
                <button type="button" disabled={busy} aria-pressed={manualDirection === "exit"} onClick={() => setManualDirection("exit")}><ArrowUpRight />Exit</button>
              </div>}
              <label htmlFor="terminal-barcode" className={styles.fieldLabel}>Person or asset barcode</label>
              <div className={styles.barcodeInput}>
                <Barcode aria-hidden="true" />
                <input id="terminal-barcode" ref={barcodeInputRef} autoComplete="off" autoCapitalize="none" spellCheck={false} value={barcode} disabled={busy} aria-invalid={Boolean(scanError)} aria-describedby={scanError ? "terminal-scan-error" : undefined} maxLength={BARCODE_MAX_LENGTH} placeholder="Scan or enter a barcode" onChange={(event) => { setBarcode(event.target.value); setScanError(""); }} />
                <button className={styles.submitButton} type="submit" disabled={busy || !checkpoint} aria-label={isScanning ? "Checking access" : "Check access"} title="Check access">{isScanning ? <Loader2 className={styles.spin} /> : <ArrowRight />}</button>
              </div>
              {hardwareBarcodes.length > 0 && <div className={styles.hardwareFields}>
                {hardwareBarcodes.map((value, index) => <div className={styles.hardwareField} key={index}>
                  <label className={styles.srOnly} htmlFor={`terminal-hardware-${index}`}>Hardware barcode {index + 1}</label>
                  <input id={`terminal-hardware-${index}`} autoFocus={index === hardwareBarcodes.length - 1} autoComplete="off" autoCapitalize="none" spellCheck={false} value={value} disabled={busy} placeholder={`Hardware barcode ${index + 1}`} maxLength={BARCODE_MAX_LENGTH} onChange={(event) => { setHardwareBarcodes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item)); setScanError(""); }} />
                  <button className={styles.iconButton} type="button" disabled={busy} aria-label={`Remove hardware barcode ${index + 1}`} onClick={() => { setHardwareBarcodes((current) => current.filter((_, itemIndex) => itemIndex !== index)); setScanError(""); }}><X /></button>
                </div>)}
              </div>}
              <button type="button" className={styles.textButton} disabled={busy || hardwareBarcodes.length >= MAX_HARDWARE_BARCODES} aria-label="Add carried hardware" onClick={() => setHardwareBarcodes((current) => [...current, ""])}><Plus /></button>
              {scanError && <p id="terminal-scan-error" className={styles.scanError} role="alert">{scanError}</p>}
            </form>
          </section>

          <section className={styles.result} data-result={result} aria-label="Scan result" aria-live="polite" aria-atomic="true" aria-busy={isScanning}>
            <span className={styles.resultEyebrow}>{latestQueuedScan ? "Queued scan" : decision && !isScanning ? "Latest result" : "Access check"}</span>
            <div className={styles.resultBody}>
              <span className={styles.resultIcon} aria-hidden="true">{result === "scanning" ? <Loader2 className={styles.spin} /> : result === "queued" ? <CloudOff /> : result === "approved" ? <Check /> : result === "denied" ? <X /> : result === "pending" ? <Clock3 /> : <ScanLine />}</span>
              <div className={styles.resultContent}>
                <div className={styles.resultTitleLine}>
                  <h2>{title}</h2>
                  {decision && !isScanning && <div className={styles.resultMeta}>
                    <span className={styles.resultChip} data-direction={decision.event.direction}>{direction}</span>
                    <span className={styles.resultChip} data-type="time">{formatTerminalTime(decision.event.createdAt, decision.event.time)}</span>
                    {decision.carriedHardware.length > 0 && <span className={styles.resultChip}>{decision.carriedHardware.length} hardware {decision.carriedHardware.length === 1 ? "item" : "items"}</span>}
                  </div>}
                </div>
                {decision && !isScanning && <div className={styles.resultSubject}><strong>{decision.event.subjectName}</strong><span>{decision.event.barcode}</span></div>}
                {description && <p>{description}</p>}
                {decision && !isScanning && <>
                  <div className={styles.resultActions}>
                    {result === "denied" && !review && <label className={styles.reviewNote}>
                      <span>Request note <em>Required</em></span>
                      <textarea
                        value={reviewNote}
                        disabled={busy}
                        required
                        maxLength={1000}
                        placeholder="Add context for the request, such as ID or visitor details."
                        onChange={(event) => setReviewNote(event.target.value)}
                      />
                    </label>}
                    {result === "denied" && !review && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void requestReview()}>{isReviewing ? <Loader2 className={styles.spin} /> : <UserRound />}{isReviewing ? "Requesting…" : "Request permission"}</button>}
                  </div>
                </>}
              </div>
            </div>
          </section>
          <PendingPermissions requests={manualApprovalRequests} onAcknowledge={acknowledgeReview} acknowledgingId={acknowledgingRequestId} />
        </div>
        <TerminalActivity movements={checkpointMovements} requests={manualApprovalRequests} />
      </div>
    </main>
  );
}
