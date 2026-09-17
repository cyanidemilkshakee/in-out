"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { emptyData } from "./dataDefaults";
import { scopeForPath } from "./dataHelpers";
import { useDataActions as useDataActionSet } from "./useDataActions";
import type { DataActions, DataProviderProps, DataState } from "./dataTypes";

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
    eventSource.onmessage = (event) => {
      if (event.data?.trim()) void refresh();
    };
    return () => eventSource.close();
  }, [refresh, scope]);

  // Keep the approval queue usable while the notification channel reconnects.
  useEffect(() => {
    if (scope !== "permissions") return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
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
