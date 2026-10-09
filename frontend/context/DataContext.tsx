"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { emptyData } from "./dataDefaults";
import { scopeForPath } from "./dataHelpers";
import { useDataActions as useDataActionSet } from "./useDataActions";
import type { DataActions, DataProviderProps, DataState } from "./dataTypes";
import { applyPresenceUpdate, parsePresenceUpdate, type PresenceUpdate } from "./presenceUpdates";

export type { DataActions, DataState } from "./dataTypes";

const DataStateContext = createContext<DataState | null>(null);
const DataActionsContext = createContext<DataActions | null>(null);

export function DataProvider({
  children,
  service,
  initialData,
  initialScope,
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

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const revisionAtStart = streamRevision.current;
    snapshotInFlight.current = true;
    bufferedUpdates.current = [];
    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const snapshot = await service.getSnapshot(scope);
      if (version !== refreshVersion.current) return;
      // A request snapshot can finish after a newer scan arrived on the stream.
      // Replay those updates over it; immutable movement IDs deduplicate events
      // that the database snapshot already contains.
      const updates = bufferedUpdates.current.filter(item => item.revision > revisionAtStart);
      const base: DataState = { ...emptyData, ...snapshot, isLoading: false, error: null };
      setState(updates.reduce((next, item) => applyPresenceUpdate(next, item.update), base));
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
  }, [scope, service]);

  useEffect(() => {
    if (hydratedScope.current === scope) {
      hydratedScope.current = undefined;
      return () => { refreshVersion.current++; };
    }
    setState({ ...emptyData, isLoading: true, error: null });
    void refresh();
    return () => { refreshVersion.current++; };
  }, [refresh, scope]);

  useEffect(() => {
    if (scope === "profile") return;
    const receiveMessage = (raw: string) => {
      if (!raw?.trim()) return;
      try {
        const update = parsePresenceUpdate(raw);
        if (update) {
          const revision = ++streamRevision.current;
          if (snapshotInFlight.current) bufferedUpdates.current.push({ revision, update });
          setState((current) => applyPresenceUpdate(current, update));
          if (update.request || update.permission || update.type === "data_changed" || (scope === "terminal" && update.type === "terminal_assignment")) void refresh();
        }
      } catch {
        // A reconnect refresh restores state after a malformed event.
      }
    };
    if (pathname.startsWith("/admin")) {
      // The admin chrome owns one shared stream for page data and alert counts.
      const receive = (event: Event) => receiveMessage((event as CustomEvent<string>).detail);
      const syncFromServer = () => void refresh();
      const restore = () => {
        if (document.visibilityState === "visible") void refresh();
      };
      window.addEventListener("inout:presence-message", receive);
      window.addEventListener("inout:presence-sync", syncFromServer);
      window.addEventListener("focus", restore);
      window.addEventListener("online", restore);
      document.addEventListener("visibilitychange", restore);
      return () => {
        window.removeEventListener("inout:presence-message", receive);
        window.removeEventListener("inout:presence-sync", syncFromServer);
        window.removeEventListener("focus", restore);
        window.removeEventListener("online", restore);
        document.removeEventListener("visibilitychange", restore);
      };
    }
    const eventSource = new EventSource("/api/presence");
    eventSource.onopen = () => {
      // Reconcile the initial snapshot and any gap left by a lost connection.
      window.clearTimeout(reconnectRefresh.current);
      reconnectRefresh.current = window.setTimeout(() => void refresh(), 250);
    };
    eventSource.onmessage = (event) => {
      receiveMessage(event.data);
    };
    const restore = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      eventSource.close();
      window.removeEventListener("focus", restore);
      window.removeEventListener("online", restore);
      document.removeEventListener("visibilitychange", restore);
      window.clearTimeout(reconnectRefresh.current);
      reconnectRefresh.current = undefined;
    };
  }, [refresh, scope, pathname]);

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
