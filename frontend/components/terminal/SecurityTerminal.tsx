"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, ArrowRight, Barcode, Check, ChevronDown, Clock3, CloudOff, Loader2, Moon, Plus, ScanLine, Sun, UserRound, X } from "lucide-react";
import { useDataActions, useDataState } from "../../context/DataContext";
import { useAdminTheme } from "../../hooks/useAdminTheme";
import type { Person, PermissionRequest, RecordScanInput, ScanDecision, TerminalVisitor } from "../../../lib/types";
import { DataServiceError } from "../../../services/httpDataService";
import { useDateTimeNow } from "../../hooks/useDateTimeNow";
import { formatRequestDate } from "../admin/permissions/requestPresentation";
import {
  cacheTerminalConfig,
  enqueueTerminalScan,
  holdQueuedTerminalScan,
  listQueuedTerminalScans,
  loadCachedTerminalConfig,
  recordQueuedScanFailure,
  removeQueuedTerminalScan,
  queuedScanHoldReason,
  queuedScanIdentityHoldReason,
  sampleQueueServerClock,
  queueCaptureTime,
  heldTerminalScanEvidence,
  syncQueuedTerminalScans,
  visibleQueuedScans,
  type CachedTerminalConfig,
  type QueuedTerminalScan,
} from "../../lib/offlineTerminalQueue";
import { AccountActions } from "../AccountActions";
import { formatTerminalTime, TerminalNotifications, TerminalActivity } from "./TerminalPanels";
import { VisitorRegistrationDialog, VisitorRegistrationNotice } from "../visitors/VisitorRegistrationDialog";
import styles from "./SecurityTerminal.module.css";

const BARCODE_MAX_LENGTH = 64;
const MAX_HARDWARE_BARCODES = 4;
const BARCODE_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const VISITOR_STATUS_LABELS: Record<TerminalVisitor["status"], string> = {
  pending: "Pending approval",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  restricted: "Restricted",
  inactive: "Inactive",
};

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

export function SecurityTerminal({
  operatorSubject,
  accountName,
  accountEmail,
  accountRole,
  canManagePermissions = false,
}: {
  operatorSubject: string;
  accountName: string;
  accountEmail: string;
  accountRole: string;
  canManagePermissions?: boolean;
}) {
  const { hardwareAssets, checkpoints, terminalAssignment, terminalReplayPolicy, movements, permissionRequests, terminalVisitors, terminalVisitorsCursor, terminalVisitorsHasMore, adminAvailability, error, isLoading } = useDataState();
  const { recordScan, loadTerminalReplayPolicy, loadMoreTerminalVisitors, requestBarcodeManualReview, submitPermissionRequest, dismissPermissionNotification, createVisitor, refresh } = useDataActions();
  const theme = useAdminTheme();
  const [manualDirection, setManualDirection] = useState<"entry" | "exit">("entry");
  const [barcode, setBarcode] = useState("");
  const [hardwareBarcodes, setHardwareBarcodes] = useState<string[]>([]);
  const [decision, setDecision] = useState<ScanDecision | null>(null);
  const [submittedReview, setSubmittedReview] = useState<PermissionRequest | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewNoteRequired, setReviewNoteRequired] = useState(false);
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
  const [dismissingRequestId, setDismissingRequestId] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState("");
  const [visitorPageLoading, setVisitorPageLoading] = useState(false);
  const [visitorPageError, setVisitorPageError] = useState("");
  const [visitorDialogOpen, setVisitorDialogOpen] = useState(false);
  const [registeredVisitor, setRegisteredVisitor] = useState<Person | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const reviewNoteInputRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const queueSyncRef = useRef(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissingRequestRef = useRef<string | null>(null);
  const accountRef = useRef<HTMLDetailsElement>(null);

  const ownedCache = operatorSubject && cachedTerminalConfig?.operatorSubject === operatorSubject ? cachedTerminalConfig : null;
  const terminalCheckpoints = terminalAssignment?.operatorSubject === operatorSubject
    ? checkpoints.filter(item => item.id === terminalAssignment.checkpointId)
    : ownedCache?.checkpoints.length === 1 ? ownedCache.checkpoints : [];
  const terminalHardwareAssets = hardwareAssets.length ? hardwareAssets : ownedCache?.hardwareAssets ?? [];
  const checkpoint = terminalCheckpoints[0];
  // Only the live DataProvider snapshot creates a clock. Cached policy is evidence,
  // never a source for elapsed time after a browser reload.
  const replayClock = useMemo(() => sampleQueueServerClock(terminalReplayPolicy), [terminalReplayPolicy]);
  const activeCheckpointRef = useRef(checkpoint?.id);
  activeCheckpointRef.current = checkpoint?.id;
  const visitorPageRequestRef = useRef<string | null>(null);
  const queueContextRef = useRef({ operatorSubject, checkpointId: checkpoint?.id, replayClock });
  queueContextRef.current = { operatorSubject, checkpointId: checkpoint?.id, replayClock };
  const pendingQueueCount = queuedScans.filter(scan => scan.operatorSubject === operatorSubject && scan.status !== "held").length;
  const heldScans = visibleQueuedScans(queuedScans, operatorSubject).filter(scan => scan.status === "held" || queuedScanHoldReason(scan, queueContextRef.current));
  const retryableHeldCount = heldScans.filter(scan => scan.replayCapturedAt && !queuedScanIdentityHoldReason(scan, queueContextRef.current)).length;
  const latestQueueHeld = Boolean(latestQueuedScan && (latestQueuedScan.status === "held" || queuedScanHoldReason(latestQueuedScan, queueContextRef.current)));
  const checkpointMovements = useMemo(() => movements.filter((movement) => movement.checkpointId === checkpoint?.id), [movements, checkpoint?.id]);
  const checkpointReviews = useMemo(() => permissionRequests.filter((request) => request.type === "manual_override" && request.checkpointId === checkpoint?.id), [permissionRequests, checkpoint?.id]);
  const visibleTerminalVisitors = useMemo(() => [...terminalVisitors].sort((left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "")), [terminalVisitors]);
  useEffect(() => {
    const checkpointId = checkpoint?.id;
    if (!checkpointId || terminalVisitorsHasMore !== true || terminalVisitorsCursor !== undefined || visitorPageRequestRef.current === checkpointId) return;
    visitorPageRequestRef.current = checkpointId;
    setVisitorPageLoading(true);
    setVisitorPageError("");
    void loadMoreTerminalVisitors().catch((error: unknown) => {
      setVisitorPageError(messageFor(error, "Unable to load expected visitors."));
    }).finally(() => {
      visitorPageRequestRef.current = null;
      setVisitorPageLoading(false);
    });
  }, [checkpoint?.id, terminalVisitorsCursor, terminalVisitorsHasMore, loadMoreTerminalVisitors]);
  const registeredVisitorStatus = registeredVisitor
    ? terminalVisitors.find((visitor) => visitor.id === registeredVisitor.id)?.status
    : undefined;
  const manualApprovalRequests = useMemo(() => {
    if (!submittedReview || checkpointReviews.some((request) => request.id === submittedReview.id)) return checkpointReviews;
    return [submittedReview, ...checkpointReviews];
  }, [checkpointReviews, submittedReview]);
  const review = (decision && checkpointReviews.find((request) => request.id === decision.event.manualApprovalRequestId || request.id === submittedReview?.id || request.eventId === decision.event.id)) ||
    (submittedReview && (!decision || submittedReview.eventId === decision.event.id) ? submittedReview : undefined);
  const now = useDateTimeNow(Boolean(review?.status === "approved" && !review.consumedAt && review.validTo));
  const approvalAwaitingScan = Boolean(review?.status === "approved" && !review.consumedAt && decision?.event.id === review.eventId);
  const approvalExpired = Boolean(approvalAwaitingScan && review?.validTo && Date.parse(review.validTo) <= now.getTime());
  const result = isScanning ? "scanning" : latestQueuedScan ? "queued" : decision?.replayed ? "recorded" : review?.status === "pending" ? "pending" : review?.status ?? decision?.event.result ?? "idle";
  const hasEntryRestriction = Boolean(decision?.entryRestrictions?.some((restriction) => restriction.active));
  const direction = decision?.event.direction === "exit" ? "Exit" : "Entry";
  const busy = isScanning || isReviewing;
  const estimatedAdminReturn = adminAvailability?.status === "offline" && adminAvailability.availableAt
    ? formatTerminalTime(adminAvailability.availableAt)
    : null;
  const adminOfflineNotice = estimatedAdminReturn
    ? `The administrator is offline. ${result === "pending" && !hasEntryRestriction ? "This permission may be picked up" : "Manual reviews may be picked up"} around ${estimatedAdminReturn}.`
    : null;
  const title = result === "recorded" ? "Previously recorded scan" : result === "scanning" ? "Checking access" : result === "queued" ? latestQueueHeld ? "Scan held for review" : "Scan queued for verification" : result === "pending" ? "Awaiting approval" : approvalAwaitingScan ? approvalExpired ? "Approval expired" : "Approved · rescan" : result === "approved" ? `${direction} allowed` : result === "denied" ? "Access denied" : "Ready to scan";
  const denialReason = decision?.event.reason?.trim();
  const description = result === "recorded" ? "This scan was recorded earlier. It does not authorize another movement. Scan again for a current access decision." : result === "scanning" ? "Verifying this barcode…" : result === "queued" ? latestQueueHeld ? "This scan needs an explicit retry or administrator reconciliation. Its original record is preserved on this device. Do not grant access until the server confirms it." : "This scan is stored on this terminal and will be sent when the connection returns. Do not grant access until the server confirms it." : result === "pending" ? hasEntryRestriction ? "Manual review requested. Entry remains blocked until an administrator lifts the entry restriction." : adminOfflineNotice ? null : "An administrator is reviewing this permission." : approvalAwaitingScan ? approvalExpired ? `This one-${direction.toLowerCase()} approval has expired. Request a new review before allowing ${direction.toLowerCase()}.` : review?.validTo ? `Rescan this barcode at the checkpoint before ${formatRequestDate(review.validTo)} to use the one-${direction.toLowerCase()} approval.` : "This approval has no active rescan window. Request a new review." : review?.status === "approved" && decision?.event.manualApprovalRequestId ? "The approved rescan is recorded. The matching exit remains allowed." : review?.status === "approved" ? "Approval is ready. Rescan the barcode before its validity window expires." : review?.status === "denied" ? "The administrator declined this request." : result === "denied" ? denialReason && denialReason !== "-" && denialReason.toLowerCase() !== "access denied" ? `Reason: ${denialReason}` : "Reason: This scan does not meet the current access policy." : decision ? decision.event.reason && decision.event.reason !== "-" ? decision.event.reason : "Access verified. You may proceed." : "The access decision will appear here.";

  const refreshQueuedScans = useCallback(async () => {
    const pending = visibleQueuedScans(await listQueuedTerminalScans(), operatorSubject);
    if (queueContextRef.current.operatorSubject !== operatorSubject) return [];
    setQueuedScans(pending);
    setLatestQueuedScan(current => current ? pending.find(scan => scan.idempotencyKey === current.idempotencyKey) ?? null : null);
    return pending;
  }, [operatorSubject]);

  const queueScanForLater = useCallback(async (
    input: RecordScanInput,
    idempotencyKey?: string,
    serverCapturedAt?: string,
  ) => {
    const queued = await enqueueTerminalScan(input, operatorSubject, idempotencyKey, serverCapturedAt);
    if (queueContextRef.current.operatorSubject !== operatorSubject) return;
    setLatestQueuedScan(queued);
    await refreshQueuedScans();
    setQueueStatus(queued.status === "held"
      ? "Scan held on this device because its server capture time is unavailable. Export it for administrator reconciliation."
      : "Scan queued on this device. The server replay policy will be checked after reconnection.");
    setBarcode("");
    setHardwareBarcodes([]);
  }, [operatorSubject, refreshQueuedScans]);

  const synchronizeQueuedScans = useCallback(async (retryHeld = false) => {
    if (queueSyncRef.current) return;
    if (typeof navigator === "undefined" || !navigator.onLine) {
      setQueueStatus("Waiting for a network connection before syncing queued scans.");
      return;
    }

    queueSyncRef.current = true;
    setIsQueueSyncing(true);
    try {
      const pending = await listQueuedTerminalScans();
      const { synced, held, paused } = await syncQueuedTerminalScans(pending,
        { operatorSubject, checkpointId: activeCheckpointRef.current }, {
          currentContext: () => queueContextRef.current,
          loadReplayPolicy: loadTerminalReplayPolicy,
          send: recordScan,
          remove: async key => {
            await removeQueuedTerminalScan(key);
            setLatestQueuedScan(current => current?.idempotencyKey === key ? null : current);
          },
          hold: holdQueuedTerminalScan,
          fail: recordQueuedScanFailure,
        }, retryHeld);
      const remaining = await refreshQueuedScans();
      if (queueContextRef.current.operatorSubject !== operatorSubject) return;
      const heldReason = remaining.find(scan => scan.status === "held")?.heldReason;
      setQueueStatus(paused ? `Retry paused: ${paused}` :
        `${synced} scan${synced === 1 ? "" : "s"} verified.${held ? ` ${held} held for review; original records are preserved.${heldReason ? ` ${heldReason}` : ""}` : remaining.length ? " Remaining scans await retry." : " No scans await retry."}`);
      if (synced) await refresh();
    } catch (queueError) {
      setQueueStatus(messageFor(queueError, "Unable to access the offline scan queue."));
    } finally {
      queueSyncRef.current = false;
      setIsQueueSyncing(false);
    }
  }, [operatorSubject, recordScan, loadTerminalReplayPolicy, refresh, refreshQueuedScans]);

  function exportHeldScans() {
    let url: string | undefined;
    try {
      const evidence = JSON.stringify(heldTerminalScanEvidence(heldScans, queueContextRef.current, new Date().toISOString()), null, 2);
      url = URL.createObjectURL(new Blob([evidence], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "held-terminal-scans.json";
      link.click();
      setQueueStatus("Held scan export prepared. Check your downloads; the original records remain on this device.");
    } catch (exportError) {
      setQueueStatus(messageFor(exportError, "Unable to export held scan evidence. The records remain on this device."));
    } finally { if (url) URL.revokeObjectURL(url); }
  }

  useEffect(() => { barcodeInputRef.current?.focus(); }, []);
  useEffect(() => {
    setDecision(null);
    setSubmittedReview(null);
    setReviewNote("");
    setReviewNoteRequired(false);
    setScanError("");
    setNotificationError("");
    setScanFeedback(null);
    setLatestQueuedScan(null);
    setManualDirection("entry");
  }, [operatorSubject, checkpoint?.id]);
  useEffect(() => { setQueuedScans([]); setQueueStatus(""); }, [operatorSubject]);
  useEffect(() => {
    void Promise.all([loadCachedTerminalConfig(), refreshQueuedScans()])
      .then(([cached]) => setCachedTerminalConfig(cached))
      .catch((queueError) => setQueueStatus(messageFor(queueError, "Unable to load offline terminal data.")));
  }, [refreshQueuedScans]);
  useEffect(() => {
    if (!terminalAssignment || terminalAssignment.operatorSubject !== operatorSubject) return;
    void cacheTerminalConfig({ operatorSubject, checkpoints: checkpoints.filter(item => item.id === terminalAssignment.checkpointId), hardwareAssets, terminalReplayPolicy })
      .catch((queueError) => setQueueStatus(messageFor(queueError, "Unable to cache terminal configuration.")));
  }, [checkpoints, hardwareAssets, terminalAssignment, terminalReplayPolicy, operatorSubject]);
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
    if (networkOnline && pendingQueueCount) void synchronizeQueuedScans();
  }, [networkOnline, pendingQueueCount, synchronizeQueuedScans]);
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
    setReviewNoteRequired(false);
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
        expectedOperatorSubject: operatorSubject,
      };
      const idempotencyKey = crypto.randomUUID();
      // Capture before the first attempt: a lost-response timeout must not make
      // the retry evidence newer than a receipt the server already committed.
      const serverCapturedAt = queueCaptureTime(queueContextRef.current.replayClock);
      if (!networkOnline) {
        await queueScanForLater({ ...input, capturedOfflineAt: new Date().toISOString() }, idempotencyKey, serverCapturedAt);
        return;
      }
      let response;
      try {
        response = await recordScan(input, idempotencyKey);
      } catch (cause) {
        if (!isRecoverableConnectionFailure(cause)) throw cause;
        await queueScanForLater(input, idempotencyKey, serverCapturedAt);
        return;
      }
      if (queueContextRef.current.operatorSubject !== operatorSubject || response.decision.event.checkpointId !== activeCheckpointRef.current) return;
      setDecision(response.decision);
      if (!response.decision.replayed && (response.decision.event.result === "approved" || response.decision.event.result === "denied")) {
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
    if (!decision || decision.replayed || review || busyRef.current) return;
    const operatorNote = reviewNote.trim();
    if (!operatorNote) {
      setReviewNoteRequired(true);
      reviewNoteInputRef.current?.focus();
      return;
    }
    setReviewNoteRequired(false);
    busyRef.current = true;
    setIsReviewing(true);
    setScanError("");
    try {
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
      if (request.checkpointId !== activeCheckpointRef.current) return;
      setSubmittedReview(request);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : "Unable to request permission. Please try again.");
    } finally {
      busyRef.current = false;
      setIsReviewing(false);
    }
  }

  async function dismissNotification(requestId: string) {
    if (dismissingRequestRef.current) return;
    const checkpointId = activeCheckpointRef.current;
    dismissingRequestRef.current = requestId;
    setDismissingRequestId(requestId);
    setNotificationError("");
    try {
      const request = await dismissPermissionNotification(requestId);
      setSubmittedReview((current) => current?.id === request.id ? request : current);
    } catch (cause) {
      if (checkpointId === activeCheckpointRef.current) {
        setNotificationError(`Unable to dismiss notification. ${messageFor(cause, "Please try again.")}`);
      }
    } finally {
      dismissingRequestRef.current = null;
      setDismissingRequestId(null);
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
              <div className={styles.accountMenu}>
                <div className={styles.accountIdentity}>
                  <strong>{accountName || accountEmail || "Signed-in account"}</strong>
                  {accountName && accountEmail && <span>{accountEmail}</span>}
                  <small>{accountRole}</small>
                </div>
                {canManagePermissions && <div className={styles.adminAccountLinks}><Link href="/admin/dashboard">Dashboard</Link><Link href="/admin/users">Manage users</Link></div>}
                <AccountActions />
              </div>
            </details>
          </div>
        </header>

        <section className={styles.heading} aria-labelledby="terminal-title">
          <div className={styles.headingCopy}><h1 id="terminal-title">Security terminal</h1></div>
          <button type="button" className={`${styles.secondaryButton} ${styles.registerVisitorButton}`} disabled={busy || !networkOnline} aria-haspopup="dialog" aria-expanded={visitorDialogOpen} onClick={() => { setRegisteredVisitor(null); setVisitorDialogOpen(true); }}><UserRound />Register visitor</button>
          <div className={styles.checkpointControl}>
            <span>Assigned checkpoint</span>
            <strong className={styles.assignedCheckpoint}>{checkpoint?.name ?? (isLoading ? "Loading assignment…" : "No checkpoint assigned")}</strong>
            {!checkpoint && !isLoading && <small>
              No checkpoint is assigned to {accountName || accountEmail || "this account"}. Assignments are per signed-in account; ask an administrator to check this account in Manage users.
            </small>}
            {!checkpoint && <button type="button" className={styles.secondaryButton} onClick={() => void refresh()} disabled={!networkOnline || isLoading}>
              {isLoading ? "Refreshing…" : "Refresh assignment"}
            </button>}
          </div>
          {registeredVisitor && <div className={styles.registrationNotice}><VisitorRegistrationNotice visitor={registeredVisitor} status={registeredVisitorStatus} canManagePermissions={canManagePermissions} /></div>}
        </section>

        {error && !terminalCheckpoints.length && <div className={styles.connectionError} role="alert"><span>Unable to update terminal data. {error}</span><button type="button" onClick={() => void refresh()} disabled={isLoading}>Retry</button></div>}
        {(!networkOnline || pendingQueueCount > 0 || heldScans.length > 0 || queueStatus) && <div className={styles.queueStatus} data-online={networkOnline}>
          <span>{networkOnline ? "Online" : "Offline"}</span>
          {(pendingQueueCount > 0 || heldScans.length > 0) && <p>{pendingQueueCount > 0 && `${pendingQueueCount} scan${pendingQueueCount === 1 ? "" : "s"} awaiting retry.`}{heldScans.length > 0 && ` ${heldScans.length} held for review.`}</p>}
          {pendingQueueCount > 0 && <button type="button" onClick={() => void synchronizeQueuedScans()} disabled={!networkOnline || isQueueSyncing}>{isQueueSyncing ? "Retrying…" : "Retry queued scans"}</button>}
          {retryableHeldCount > 0 && <button type="button" onClick={() => void synchronizeQueuedScans(true)} disabled={!networkOnline || isQueueSyncing}>Check held scans</button>}
          {heldScans.length > 0 && <><button type="button" onClick={exportHeldScans}>Export held scans</button><small>Checking held scans revalidates the server policy. Expired or unverifiable evidence requires administrator reconciliation and cannot be retried.</small></>}
          {queueStatus && <small role="status">{queueStatus}</small>}
        </div>}

        <div className={styles.scanWorkspace}>
          {checkpoint && <section className={styles.visitorRoster} aria-labelledby="terminal-visitors-title">
            <header className={styles.visitorRosterHeader}>
              <h2 id="terminal-visitors-title">Expected visitors</h2>
              <span>{checkpoint.name} · {visibleTerminalVisitors.length}{terminalVisitorsHasMore ? "+" : ""} registered</span>
            </header>
            <ul className={`${styles.visitorRosterList} scrollable-content`}>
              {visibleTerminalVisitors.length ? visibleTerminalVisitors.map((visitor) => (
                <li key={visitor.id}>
                  <div className={styles.visitorRosterIdentity}>
                    <strong>{visitor.name}<span>{visitor.barcode}</span></strong>
                    <small>{[visitor.company, visitor.host ? `Host: ${visitor.host}` : "", visitor.allowedZones.length ? `Zones: ${visitor.allowedZones.join(", ")}` : "No zones assigned", visitor.validFrom ? `From ${formatRequestDate(visitor.validFrom)}` : "", visitor.validTo ? `Until ${formatRequestDate(visitor.validTo)}` : "No expiry"].filter(Boolean).join(" · ")}</small>
                  </div>
                  <span className={styles.visitorRosterStatus} data-status={visitor.status}>{VISITOR_STATUS_LABELS[visitor.status]}</span>
                </li>
              )) : <li className={styles.visitorRosterEmpty}>No visitors registered for this checkpoint.</li>}
            </ul>
            {visitorPageError && <p role="alert">{visitorPageError}</p>}
            {terminalVisitorsHasMore && <button type="button" className={styles.textButton}
              disabled={visitorPageLoading || !networkOnline}
              onClick={() => {
                setVisitorPageLoading(true);
                setVisitorPageError("");
                void loadMoreTerminalVisitors(terminalVisitorsCursor ?? undefined).catch((error: unknown) => {
                  setVisitorPageError(messageFor(error, "Unable to load expected visitors."));
                }).finally(() => setVisitorPageLoading(false));
              }}>
              {visitorPageLoading ? "Loading visitors…" : terminalVisitorsCursor ? "Load more visitors" : "Load visitors"}
            </button>}
          </section>}
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
            <span className={styles.resultEyebrow}>{latestQueuedScan ? latestQueueHeld ? "Held scan" : "Queued scan" : decision && !isScanning ? "Latest result" : "Access check"}</span>
            <div className={styles.resultBody}>
              <span className={styles.resultIcon} aria-hidden="true">{result === "scanning" ? <Loader2 className={styles.spin} /> : result === "queued" ? <CloudOff /> : result === "approved" ? <Check /> : result === "denied" ? <X /> : result === "pending" ? <Clock3 /> : <ScanLine />}</span>
              <div className={styles.resultContent}>
                <div className={styles.resultTitleLine}>
                  <h2>{title}</h2>
                  {decision && !isScanning && <div className={styles.resultMeta}>
                    <span className={styles.resultChip} data-direction={decision.event.direction}>{direction}</span>
                    <span className={styles.resultChip} data-type="time">{formatTerminalTime(decision.event.createdAt, decision.event.time)}</span>
                  </div>}
                </div>
                {decision && !isScanning && <div className={styles.resultSubject}><strong>{decision.event.subjectName}</strong><span>{decision.event.barcode}</span></div>}
                {decision && !isScanning && decision.carriedHardware.length > 0 && <div className={styles.resultHardware} aria-label="Carried hardware">
                  {decision.carriedHardware.map((asset) => <div className={styles.resultHardwareItem} key={asset.id}><strong>{asset.name}</strong><span>{asset.barcode}</span></div>)}
                </div>}
                {description && <p>{description}</p>}
                {result === "denied" && hasEntryRestriction && <p className={styles.entryHoldNotice}>
                  Entry stays restricted until an admin lifts the entry restriction. A manual review request does not lift the hold.
                </p>}
                {decision && !isScanning && <>
                  <div className={styles.resultActions}>
                    {result === "denied" && !review && <label className={`${styles.reviewNote}${reviewNoteRequired ? ` ${styles.reviewNoteInvalid}` : ""}`}>
                      <span className={styles.srOnly}>Request note</span>
                      <textarea
                        ref={reviewNoteInputRef}
                        value={reviewNote}
                        disabled={busy}
                        required
                        aria-invalid={reviewNoteRequired}
                        maxLength={1000}
                        placeholder="Add a request note, such as ID or visitor details."
                        onChange={(event) => {
                          const value = event.target.value;
                          setReviewNote(value);
                          if (value.trim()) {
                            setReviewNoteRequired(false);
                          }
                        }}
                      />
                    </label>}
                    {result === "denied" && !review && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void requestReview()}>{isReviewing ? <Loader2 className={styles.spin} /> : <UserRound />}{isReviewing ? "Requesting…" : "Request manual review"}</button>}
                  </div>
                </>}
              </div>
            </div>
          </section>
          {adminOfflineNotice && <p className={styles.adminOfflineNotice} role="status">{adminOfflineNotice}</p>}
          <TerminalNotifications requests={manualApprovalRequests} onDismiss={dismissNotification} dismissingId={dismissingRequestId} dismissError={notificationError} />
        </div>
        <TerminalActivity movements={checkpointMovements} requests={manualApprovalRequests} />
      </div>
      <VisitorRegistrationDialog open={visitorDialogOpen} onClose={() => setVisitorDialogOpen(false)} onCreate={createVisitor} onCreated={setRegisteredVisitor} checkpoints={terminalCheckpoints} online={networkOnline} />
    </main>
  );
}
