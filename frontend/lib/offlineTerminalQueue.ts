import type { Checkpoint, HardwareAsset, RecordScanInput, TerminalReplayPolicy } from "../../lib/types";
import { canonicalCheckpointId, normalizeFacilityCheckpoints, normalizeSubjectZones } from "../../lib/facilityZones";

const DATABASE_NAME = "inout-terminal-offline";
const DATABASE_VERSION = 1;
const SCAN_STORE = "queued-scans";
const CONFIG_STORE = "terminal-config";
const CONFIG_KEY = "latest";

type QueuedScanInput = Omit<RecordScanInput, "online"> & { online?: boolean };

export type QueuedTerminalScan = {
  idempotencyKey: string;
  // Missing on legacy records: their creator cannot safely be inferred.
  operatorSubject?: string;
  status?: "pending" | "held";
  heldReason?: string;
  heldAt?: string;
  input: QueuedScanInput;
  capturedOfflineAt: string;
  // Immutable evidence from a live server clock, separate from the original
  // payload/fingerprint. Browser wall time and legacy capture dates are not age authority.
  replayCapturedAt?: string;
  attempts: number;
  lastError?: string;
};

export type QueueServerClock = { policy: TerminalReplayPolicy; sampledMonotonicMs: number; uncertaintyMs: number };
export type QueueContext = { operatorSubject: string; checkpointId?: string; replayClock?: QueueServerClock };
const DAY_MS = 86_400_000;

function utcInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && Number(value.slice(0, 4)) > 0 && new Date(instant).toISOString().slice(0, 19) === value.slice(0, 19) ? instant : undefined;
}

/** Call only with a newly received authenticated server policy, not cached data. */
export function sampleQueueServerClock(policy: TerminalReplayPolicy | undefined, requestStarted = performance.now(), receivedAt = performance.now()): QueueServerClock | undefined {
  if (!policy || !Number.isSafeInteger(policy.receiptRetentionDays) || policy.receiptRetentionDays < 0 || !Number.isSafeInteger(policy.receiptRetentionDays * DAY_MS) ||
      utcInstant(policy.serverTime) === undefined || !Number.isFinite(requestStarted) || !Number.isFinite(receivedAt) || receivedAt < requestStarted) return undefined;
  return { policy: { ...policy }, sampledMonotonicMs: receivedAt, uncertaintyMs: receivedAt - requestStarted };
}

function queueServerNow(clock: QueueServerClock | undefined, now = performance.now(), upperBound = false): number | undefined {
  if (!clock || !Number.isFinite(now) || now < clock.sampledMonotonicMs) return undefined;
  const sampled = utcInstant(clock.policy.serverTime);
  return sampled === undefined ? undefined : sampled + now - clock.sampledMonotonicMs + (upperBound ? clock.uncertaintyMs : 0);
}

export function queueCaptureTime(clock: QueueServerClock | undefined, now = performance.now()): string | undefined {
  const instant = queueServerNow(clock, now);
  return instant === undefined ? undefined : new Date(instant).toISOString();
}

export function visibleQueuedScans(scans: QueuedTerminalScan[], operatorSubject: string): QueuedTerminalScan[] {
  return scans.filter(scan => !scan.operatorSubject || scan.operatorSubject === operatorSubject);
}

export function queuedScanIdentityHoldReason(scan: QueuedTerminalScan, context: QueueContext): string | null {
  if (!scan.operatorSubject) return "This older scan has no recorded operator. Export it for administrator reconciliation.";
  if (scan.operatorSubject !== context.operatorSubject) return "This scan belongs to another operator.";
  if (!context.checkpointId || canonicalCheckpointId(scan.input.checkpointId) !== canonicalCheckpointId(context.checkpointId)) {
    return "Your assigned checkpoint has changed. Restore the original assignment before retrying this scan.";
  }
  return null;
}

export function queuedScanHoldReason(scan: QueuedTerminalScan, context: QueueContext, monotonicNow = performance.now()): string | null {
  const identityReason = queuedScanIdentityHoldReason(scan, context);
  if (identityReason) return identityReason;
  const captured = utcInstant(scan.replayCapturedAt);
  if (captured === undefined) return "This scan has no verified server capture time. Export it for administrator reconciliation; retry cannot restore its receipt history.";
  const current = queueServerNow(context.replayClock, monotonicNow, true);
  if (current === undefined) return "A fresh server replay policy is unavailable. Keep this evidence and check again after reconnecting.";
  if (captured > current) return "The verified capture time cannot be reconciled with the server clock. Export this scan for administrator reconciliation.";
  const days = context.replayClock!.policy.receiptRetentionDays;
  if (days > 0 && current - captured >= days * DAY_MS) return "This scan is outside the server receipt-retention window. Export it for administrator reconciliation; it cannot be retried.";
  return null;
}

export function heldTerminalScanEvidence(scans: QueuedTerminalScan[], context: QueueContext, exportedAt: string) {
  return { exportedAt, operatorSubject: context.operatorSubject,
    guidance: "Retained evidence only. Preserve the original key and input. Expired or unverifiable scans require administrator reconciliation; retry never bypasses the server receipt-retention window.",
    replayPolicy: context.replayClock?.policy,
    scans: visibleQueuedScans(scans, context.operatorSubject).map(scan => ({ ...scan,
      input: { ...scan.input, selectedHardwareIds: [...scan.input.selectedHardwareIds] },
      heldReason: queuedScanHoldReason(scan, context) ?? scan.heldReason })) };
}

export function isPermanentQueueFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : NaN;
  // Session expiry, throttling and timeouts can recover without changing the
  // captured scan. Other client errors require an explicit operator retry.
  return status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status);
}

type QueueSyncActions = {
  loadReplayPolicy: () => Promise<TerminalReplayPolicy | undefined>;
  currentContext: () => QueueContext;
  send: (input: RecordScanInput, idempotencyKey: string) => Promise<unknown>;
  remove: (idempotencyKey: string) => Promise<void>;
  hold: (idempotencyKey: string, reason: string) => Promise<void>;
  fail: (idempotencyKey: string, error: string, permanent: boolean) => Promise<void>;
};

export async function syncQueuedTerminalScans(
  scans: QueuedTerminalScan[], context: QueueContext, actions: QueueSyncActions, retryHeld = false,
): Promise<{ synced: number; held: number; paused: string | null }> {
  let synced = 0;
  let held = 0;
  const started = performance.now();
  let replayClock: QueueServerClock | undefined;
  try { replayClock = sampleQueueServerClock(await actions.loadReplayPolicy(), started); }
  catch { /* No cached-policy fallback can authorize a replay. */ }
  const replayContext = { ...context, replayClock };
  for (const scan of scans) {
    const current = actions.currentContext();
    if (current.operatorSubject !== context.operatorSubject || current.checkpointId !== context.checkpointId) {
      return { synced, held, paused: "Operator or checkpoint changed. Retry from the assigned terminal." };
    }
    // A shared browser never sends another account's evidence.
    if (scan.operatorSubject && scan.operatorSubject !== context.operatorSubject) continue;
    const holdReason = queuedScanHoldReason(scan, replayContext);
    if (holdReason) {
      if (scan.status !== "held" || scan.heldReason !== holdReason) await actions.hold(scan.idempotencyKey, holdReason);
      held += 1;
      continue;
    }
    if (scan.status === "held" && !retryHeld) { held += 1; continue; }
    try {
      await actions.send({ ...queuedScanInput(scan), queueCapturedAt: scan.replayCapturedAt }, scan.idempotencyKey);
      await actions.remove(scan.idempotencyKey);
      synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to sync queued scan.";
      const permanent = isPermanentQueueFailure(error);
      await actions.fail(scan.idempotencyKey, message, permanent);
      if (!permanent) return { synced, held, paused: message };
      held += 1;
    }
  }
  return { synced, held, paused: null };
}

export type CachedTerminalConfig = {
  operatorSubject?: string;
  checkpoints: Checkpoint[];
  hardwareAssets: HardwareAsset[];
  savedAt: string;
  terminalReplayPolicy?: TerminalReplayPolicy;
};

export function queuedScanInput(queued: QueuedTerminalScan): RecordScanInput {
  // Older queue entries omitted transport fields. New entries preserve the
  // exact attempted payload so a lost response never changes its fingerprint.
  const ownerGuard = queued.operatorSubject ? { expectedOperatorSubject: queued.operatorSubject } : {};
  return queued.input.online === undefined
    ? { ...queued.input, ...ownerGuard, selectedHardwareIds: [...queued.input.selectedHardwareIds], online: true, capturedOfflineAt: queued.capturedOfflineAt }
    : { ...queued.input, ...ownerGuard, selectedHardwareIds: [...queued.input.selectedHardwareIds], online: queued.input.online };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline storage transaction failed."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("This browser does not support persistent offline storage."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SCAN_STORE)) {
        database.createObjectStore(SCAN_STORE, { keyPath: "idempotencyKey" });
      }
      if (!database.objectStoreNames.contains(CONFIG_STORE)) {
        database.createObjectStore(CONFIG_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open offline storage."));
  });
}

export async function listQueuedTerminalScans(): Promise<QueuedTerminalScan[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readonly");
    const items = await requestResult(transaction.objectStore(SCAN_STORE).getAll()) as QueuedTerminalScan[];
    await transactionComplete(transaction);
    return items.sort((left, right) => String(left.capturedOfflineAt ?? "").localeCompare(String(right.capturedOfflineAt ?? "")));
  } finally {
    database.close();
  }
}

export async function enqueueTerminalScan(
  input: RecordScanInput,
  operatorSubject: string,
  idempotencyKey = crypto.randomUUID(),
  serverCapturedAt?: string,
): Promise<QueuedTerminalScan> {
  if (!operatorSubject.trim()) throw new Error("Sign in before queuing a terminal scan.");
  if (input.expectedOperatorSubject && input.expectedOperatorSubject !== operatorSubject) {
    throw new Error("This scan belongs to another operator account.");
  }
  const capturedOfflineAt = new Date().toISOString();
  const replayCapturedAt = utcInstant(serverCapturedAt) === undefined ? undefined : serverCapturedAt;
  const item: QueuedTerminalScan = {
    idempotencyKey,
    operatorSubject,
    status: replayCapturedAt ? "pending" : "held",
    ...(!replayCapturedAt ? { heldReason: "This scan has no verified server capture time. Export it for administrator reconciliation; retry cannot restore its receipt history.", heldAt: capturedOfflineAt } : {}),
    input: {
      ...input,
      expectedOperatorSubject: operatorSubject,
      selectedHardwareIds: [...input.selectedHardwareIds],
    },
    capturedOfflineAt,
    replayCapturedAt,
    attempts: 0,
  };

  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    const store = transaction.objectStore(SCAN_STORE);
    const existing = await requestResult(store.get(idempotencyKey)) as QueuedTerminalScan | undefined;
    if (existing) {
      if (existing.operatorSubject !== operatorSubject || JSON.stringify(existing.input) !== JSON.stringify(item.input)) {
        throw new Error("This queued scan key already belongs to another operator or scan.");
      }
      await transactionComplete(transaction);
      return existing;
    }
    store.put(item);
    await transactionComplete(transaction);
    return item;
  } finally {
    database.close();
  }
}

export async function removeQueuedTerminalScan(idempotencyKey: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    transaction.objectStore(SCAN_STORE).delete(idempotencyKey);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function recordQueuedScanFailure(idempotencyKey: string, error: string, permanent = false): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    const store = transaction.objectStore(SCAN_STORE);
    const item = await requestResult(store.get(idempotencyKey)) as QueuedTerminalScan | undefined;
    if (item) {
      store.put({ ...item, attempts: item.attempts + 1, lastError: error.slice(0, 500),
        ...(permanent ? { status: "held", heldReason: error.slice(0, 500), heldAt: new Date().toISOString() } : {}) });
    }
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function holdQueuedTerminalScan(idempotencyKey: string, reason: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    const store = transaction.objectStore(SCAN_STORE);
    const item = await requestResult(store.get(idempotencyKey)) as QueuedTerminalScan | undefined;
    if (item) store.put({ ...item, status: "held", heldReason: reason.slice(0, 500), heldAt: item.heldAt ?? new Date().toISOString() });
    await transactionComplete(transaction);
  } finally { database.close(); }
}

export async function cacheTerminalConfig(config: Omit<CachedTerminalConfig, "savedAt">): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CONFIG_STORE, "readwrite");
    transaction.objectStore(CONFIG_STORE).put({ id: CONFIG_KEY,
      operatorSubject: config.operatorSubject,
      checkpoints: normalizeFacilityCheckpoints(config.checkpoints),
      hardwareAssets: config.hardwareAssets.map(normalizeSubjectZones),
      terminalReplayPolicy: config.terminalReplayPolicy,
      savedAt: new Date().toISOString() });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadCachedTerminalConfig(): Promise<CachedTerminalConfig | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CONFIG_STORE, "readonly");
    const cached = await requestResult(transaction.objectStore(CONFIG_STORE).get(CONFIG_KEY)) as (CachedTerminalConfig & { id: string }) | undefined;
    await transactionComplete(transaction);
    if (!cached || !Array.isArray(cached.checkpoints) || !Array.isArray(cached.hardwareAssets)) return null;
    return {
      operatorSubject: cached.operatorSubject,
      checkpoints: normalizeFacilityCheckpoints(cached.checkpoints),
      hardwareAssets: cached.hardwareAssets.map(normalizeSubjectZones),
      terminalReplayPolicy: cached.terminalReplayPolicy,
      savedAt: cached.savedAt,
    };
  } finally {
    database.close();
  }
}
