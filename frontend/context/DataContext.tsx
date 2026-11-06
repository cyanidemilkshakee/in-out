"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { emptyData } from "./dataDefaults";
import { scopeForPath } from "./dataHelpers";
import { useDataActions as useDataActionSet } from "./useDataActions";
import type { DataActions, DataProviderProps, DataState } from "./dataTypes";
import { applyPresenceUpdate, parsePresenceUpdate, type PresenceUpdate } from "./presenceUpdates";
import { createRefreshCoordinator } from "../../lib/refreshCoordinator";
import { createRefreshScheduler } from "../../lib/refreshScheduler";

export type { DataActions, DataState } from "./dataTypes";

const DataStateContext = createContext<DataState | null>(null);
const DataActionsContext = createContext<DataActions | null>(null);

export function DataProvider({
  children,
  service,
  initialData,
  initialScope,
  clientManaged = false,
}: DataProviderProps) {
  const pathname = usePathname();
  const scope = scopeForPath(pathname);
  const [state, setState] = useState<DataState>(() => ({
    ...(initialData ?? emptyData),
    isLoading: !initialData,
    error: null,
  }));
  const hydratedScope = useRef(initialData ? initialScope ?? scope : undefined);
  const refreshVersion = useRef(0);
  const streamRevision = useRef(0);
  const bufferedUpdates = useRef<Array<{ revision: number; update: PresenceUpdate }>>([]);
  const snapshotInFlight = useRef(false);
  const reconnectRefresh = useRef<number | undefined>(undefined);
  const snapshotRevision = useRef(initialData?.eventRevision);
  const needsStreamSnapshot = useRef(false);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [snapshotCursor, setSnapshotCursor] = useState({ revision: initialData?.eventRevision, generation: 0 });

  useEffect(() => {
    if (snapshotCursor.revision === undefined || !pathname.startsWith("/admin")) return;
    let active = true;
    // Child effects run before the shared chrome installs its listener.
    queueMicrotask(() => {
      if (active) window.dispatchEvent(new CustomEvent("inout:snapshot-revision", { detail: { revision: snapshotCursor.revision, scope } }));
    });
    return () => { active = false; };
  }, [snapshotCursor, scope, pathname]);

  useEffect(() => {
    if (clientManaged && pathname.startsWith("/admin")) queueMicrotask(() => {
      window.dispatchEvent(new Event("inout:snapshot-pending"));
    });
  }, [clientManaged, pathname]);

  const loadSnapshot = useCallback(async () => {
    if (clientManaged) return;
    const version = ++refreshVersion.current;
    const revisionAtStart = streamRevision.current;
    snapshotInFlight.current = true;
    bufferedUpdates.current = [];
    setState((current) => current.error ? { ...current, error: null } : current);
    try {
      const snapshot = await service.getSnapshot(scope);
      if (version !== refreshVersion.current) return;
      // A request snapshot can finish after a newer scan arrived on the stream.
      // Replay those updates over it; immutable movement IDs deduplicate events
      // that the database snapshot already contains.
      const updates = bufferedUpdates.current.filter(item => item.revision > revisionAtStart);
      const base: DataState = { ...emptyData, ...snapshot, isLoading: false, error: null };
      setState(updates.reduce((next, item) => applyPresenceUpdate(next, item.update), base));
      setSnapshotCursor(previous => ({ revision: snapshot.eventRevision, generation: previous.generation + 1 }));
      snapshotRevision.current = snapshot.eventRevision;
      if (needsStreamSnapshot.current) {
        needsStreamSnapshot.current = false;
        setStreamGeneration(generation => generation + 1);
      }
      bufferedUpdates.current = [];
    } catch (error) {
      if (version !== refreshVersion.current) return;
      setState((current) => ({
        ...current,
        isLoading: false,
        error: error instanceof Error ? error.message : "Unable to load application data.",
      }));
    } finally {
      if (version === refreshVersion.current) snapshotInFlight.current = false;
    }
  }, [scope, service, clientManaged]);

  const refreshQueue = useMemo(() => {
    const queue = {
      active: true,
      coordinator: createRefreshCoordinator(async () => {
        if (queue.active) await loadSnapshot();
      }),
    };
    return queue;
  }, [loadSnapshot]);
  const refresh = useCallback(() => {
    if (!refreshQueue.active) return Promise.resolve();
    // Keep an already-running snapshot from undoing an optimistic mutation
    // while its single follow-up waits for that request to finish.
    refreshVersion.current++;
    return refreshQueue.coordinator.request(true);
  }, [refreshQueue]);
  const syncSnapshot = useCallback(() => refreshQueue.active
    ? refreshQueue.coordinator.request() : Promise.resolve(), [refreshQueue]);
  // Display invalidations can accept the in-flight snapshot and queue a fresh
  // follow-up. Repeated hints must not continually discard a slow read.
  const reconcileSnapshot = useCallback(() => refreshQueue.active
    ? refreshQueue.coordinator.request(true) : Promise.resolve(), [refreshQueue]);

  useEffect(() => {
    refreshQueue.active = true;
    const stop = () => {
      refreshQueue.active = false;
      refreshQueue.coordinator.clearPending();
      refreshVersion.current++;
    };
    if (hydratedScope.current === scope) {
      hydratedScope.current = undefined;
      return stop;
    }
    setState({ ...emptyData, isLoading: !clientManaged, error: null });
    snapshotRevision.current = undefined;
    // A remounted effect must not join a read invalidated by its cleanup.
    void refresh();
    return stop;
  }, [refresh, refreshQueue, scope, clientManaged]);

  useEffect(() => {
    if (scope === "profile") return;
    const streamRefresh = createRefreshScheduler(() => void reconcileSnapshot(), 120, 1_000);
    const receiveMessage = (raw: string) => {
      if (!raw?.trim()) return;
      try {
        const update = parsePresenceUpdate(raw);
        if (update) {
          const revision = ++streamRevision.current;
          if (snapshotInFlight.current) bufferedUpdates.current.push({ revision, update });
          setState((current) => applyPresenceUpdate(current, update));
          if (update.request || update.permission || update.type === "data_changed" || (scope === "terminal" && update.type === "terminal_assignment")) {
            streamRefresh.request();
          }
        }
      } catch {
        // A reconnect refresh restores state after a malformed event.
      }
    };
    if (pathname.startsWith("/admin")) {
      // The admin chrome owns one shared stream for page data and alert counts.
      const receive = (event: Event) => receiveMessage((event as CustomEvent<string>).detail);
      const syncFromServer = () => void reconcileSnapshot();
      const restore = () => {
        if (document.visibilityState === "visible") void syncSnapshot();
      };
      window.addEventListener("inout:presence-message", receive);
      window.addEventListener("inout:presence-sync", syncFromServer);
      window.addEventListener("focus", restore);
      window.addEventListener("online", restore);
      document.addEventListener("visibilitychange", restore);
      return () => {
        streamRefresh.cancel();
        window.removeEventListener("inout:presence-message", receive);
        window.removeEventListener("inout:presence-sync", syncFromServer);
        window.removeEventListener("focus", restore);
        window.removeEventListener("online", restore);
        document.removeEventListener("visibilitychange", restore);
      };
    }
    const revision = snapshotRevision.current;
    const eventSource = new EventSource(revision === undefined ? "/api/presence" : `/api/presence?since=${revision}`);
    const recoveryTimer = window.setInterval(() => { if (needsStreamSnapshot.current) void reconcileSnapshot(); }, 5_000);
    eventSource.onopen = () => {
      // Reconcile the initial snapshot and any gap left by a lost connection.
      window.clearTimeout(reconnectRefresh.current);
      if (revision === undefined) reconnectRefresh.current = window.setTimeout(() => void reconcileSnapshot(), 250);
    };
    eventSource.onmessage = (event) => {
      receiveMessage(event.data);
    };
    eventSource.addEventListener("snapshot_required", () => {
      needsStreamSnapshot.current = true;
      eventSource.close();
      void reconcileSnapshot();
    });
    const restore = () => {
      if (document.visibilityState === "visible") void syncSnapshot();
    };
    window.addEventListener("focus", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      eventSource.close();
      window.clearInterval(recoveryTimer);
      streamRefresh.cancel();
      window.removeEventListener("focus", restore);
      window.removeEventListener("online", restore);
      document.removeEventListener("visibilitychange", restore);
      window.clearTimeout(reconnectRefresh.current);
      reconnectRefresh.current = undefined;
    };
  }, [reconcileSnapshot, syncSnapshot, scope, pathname, streamGeneration]);

  const actions = useDataActionSet({ service, setState, refresh });

  return (
    <DataActionsContext.Provider value={actions}>
      <DataStateContext.Provider value={state}>{children}</DataStateContext.Provider>
    </DataActionsContext.Provider>
  );
}

export function useDataState() {
  const state = useContext(DataStateContext);
  if (!state) throw new Error("useDataState must be used within DataProvider.");
  return state;
}

export function useDataActions() {
  const actions = useContext(DataActionsContext);
  if (!actions) throw new Error("useDataActions must be used within DataProvider.");
  return actions;
}
