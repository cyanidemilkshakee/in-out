"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { emptyData } from "./dataDefaults";
import { addMovementToAnalytics, mergeById, scopeForPath } from "./dataHelpers";
import { useDataActions as useDataActionSet } from "./useDataActions";
import type { DataActions, DataProviderProps, DataState } from "./dataTypes";
import type { HardwareAsset, MovementEvent, Person, PermissionRequest } from "../../lib/types";

export type { DataActions, DataState } from "./dataTypes";

const DataStateContext = createContext<DataState | null>(null);
const DataActionsContext = createContext<DataActions | null>(null);

type PresenceUpdate = {
  subject_id?: string;
  state?: "inside" | "outside";
  movement?: MovementEvent;
  people?: Person[];
  hardwareAssets?: HardwareAsset[];
  request?: PermissionRequest;
};

function applyPresenceUpdate(current: DataState, update: PresenceUpdate): DataState {
  const isInside = update.state === "inside";
  let presenceChanged = false;
  const updatePresence = <T extends Person | HardwareAsset>(items: T[]) => items.map((item) => {
    if (!update.subject_id || !update.state || item.id !== update.subject_id || item.inside === isInside) return item;
    presenceChanged = true;
    return { ...item, inside: isInside };
  });

  const people = mergeById(updatePresence(current.people), update.people ?? []);
  const hardwareAssets = mergeById(updatePresence(current.hardwareAssets), update.hardwareAssets ?? []);
  const isNewMovement = Boolean(update.movement && !current.movements.some((movement) => movement.id === update.movement?.id));
  const movements = update.movement
    ? mergeById(current.movements, [update.movement]).slice(0, 100)
    : current.movements;
  const permissionRequests = update.request
    ? mergeById(current.permissionRequests, [update.request])
    : current.permissionRequests;

  const eventAnalytics = update.movement && isNewMovement
    ? addMovementToAnalytics(current.scanAnalytics, update.movement, update.people ?? [])
    : current.scanAnalytics;
  const presenceDelta = presenceChanged ? (isInside ? 1 : -1) : 0;
  return {
    ...current,
    people,
    hardwareAssets,
    movements,
    permissionRequests,
    scanAnalytics: {
      ...eventAnalytics,
      // Presence events are authoritative for occupancy. Keep that count out
      // of addMovementToAnalytics so an event with an updated person cannot
      // increment occupancy twice.
      activeInside: Math.max(0, current.scanAnalytics.activeInside + presenceDelta),
    },
  };
}

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
        setState((current) => applyPresenceUpdate(current, JSON.parse(event.data) as PresenceUpdate));
      } catch {
        // Ignore malformed transient events; the next reconnect fetches a
        // consistent snapshot.
      }
    };
    return () => {
      eventSource.close();
      window.clearTimeout(reconnectRefresh.current);
      reconnectRefresh.current = undefined;
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
