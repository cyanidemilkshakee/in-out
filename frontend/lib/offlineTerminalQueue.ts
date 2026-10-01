import type { Checkpoint, HardwareAsset, RecordScanInput } from "../../lib/types";

const DATABASE_NAME = "inout-terminal-offline";
const DATABASE_VERSION = 1;
const SCAN_STORE = "queued-scans";
const CONFIG_STORE = "terminal-config";
const CONFIG_KEY = "latest";

type QueuedScanInput = Omit<RecordScanInput, "online"> & { online?: boolean };

export type QueuedTerminalScan = {
  idempotencyKey: string;
  input: QueuedScanInput;
  capturedOfflineAt: string;
  attempts: number;
  lastError?: string;
};

export type CachedTerminalConfig = {
  checkpoints: Checkpoint[];
  hardwareAssets: HardwareAsset[];
  savedAt: string;
};

export function queuedScanInput(queued: QueuedTerminalScan): RecordScanInput {
  // Older queue entries omitted transport fields. New entries preserve the
  // exact attempted payload so a lost response never changes its fingerprint.
  return queued.input.online === undefined
    ? { ...queued.input, online: true, capturedOfflineAt: queued.capturedOfflineAt }
    : { ...queued.input, online: queued.input.online };
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
    return items.sort((left, right) => left.capturedOfflineAt.localeCompare(right.capturedOfflineAt));
  } finally {
    database.close();
  }
}

export async function enqueueTerminalScan(
  input: RecordScanInput,
  idempotencyKey = crypto.randomUUID(),
): Promise<QueuedTerminalScan> {
  const capturedOfflineAt = new Date().toISOString();
  const item: QueuedTerminalScan = {
    idempotencyKey,
    input: {
      ...input,
      selectedHardwareIds: [...input.selectedHardwareIds],
    },
    capturedOfflineAt,
    attempts: 0,
  };

  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    transaction.objectStore(SCAN_STORE).put(item);
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

export async function recordQueuedScanFailure(idempotencyKey: string, error: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SCAN_STORE, "readwrite");
    const store = transaction.objectStore(SCAN_STORE);
    const item = await requestResult(store.get(idempotencyKey)) as QueuedTerminalScan | undefined;
    if (item) {
      store.put({ ...item, attempts: item.attempts + 1, lastError: error.slice(0, 500) });
    }
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function cacheTerminalConfig(config: Omit<CachedTerminalConfig, "savedAt">): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CONFIG_STORE, "readwrite");
    transaction.objectStore(CONFIG_STORE).put({ id: CONFIG_KEY, ...config, savedAt: new Date().toISOString() });
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
      checkpoints: cached.checkpoints,
      hardwareAssets: cached.hardwareAssets,
      savedAt: cached.savedAt,
    };
  } finally {
    database.close();
  }
}
