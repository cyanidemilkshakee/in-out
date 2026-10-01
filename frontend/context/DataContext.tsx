"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { emptyData } from "./dataDefaults";
import { scopeForPath } from "./dataHelpers";
import { useDataActions as useDataActionSet } from "./useDataActions";
import type { DataActions, DataProviderProps, DataState } from "./dataTypes";
import { applyPresenceUpdate, parsePresenceUpdate } from "./presenceUpdates";

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
  const streamOpened = useRef(false);
  const reconnectRefresh = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const snapshot = await service.getSnapshot(scope);
      if (version !== refreshVersion.current) return;
      setState({ ...emptyData, ...snapshot, isLoading: false, error: null });
    } catch (error) {
      if (version !== refreshVersion.current) return;
      setState((current) => ({
        ...current,
        isLoading: false,
        error: error instanceof Error ? error.message : "Unable to load application data.",
      }));
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
    const eventSource = new EventSource("/api/presence");
    eventSource.onopen = () => {
      if (streamOpened.current) {
        // A stream reconnect can have missed events. Restore consistency once
        // without returning to a permanent polling loop.
        window.clearTimeout(reconnectRefresh.current);
        reconnectRefresh.current = window.setTimeout(() => void refresh(), 500);
      }
      streamOpened.current = true;
    };
    eventSource.onmessage = (event) => {
      if (!event.data?.trim()) return;
      try {
        const update = parsePresenceUpdate(event.data);
        if (update) {
          setState((current) => applyPresenceUpdate(current, update));
          // Manual requests and decisions can change both the queue and the
          // aggregate snapshot. The local merge makes the UI immediate; this
          // refresh makes every scoped view converge to the persisted state.
          if (update.request?.type === "manual_override") void refresh();
        }
      } catch {
        // Ignore malformed transient events; the next reconnect fetches a
        // consistent snapshot.
      }
    };
    return () => {
      eventSource.close();
      window.clearTimeout(reconnectRefresh.current);
      reconnectRefresh.current = undefined;
      streamOpened.current = false;
    };
  }, [refresh, scope]);

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
