"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { getDashboardKPIs } from "../../lib/analyticsUtils";
import type {
  AccessPermission,
  Alert,
  AlertRule,
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataScope,
  DataService,
  HardwareAsset,
  MovementEvent,
  MovementPage,
  MovementQuery,
  Person,
  PermissionNotification,
  PermissionRequest,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../../lib/types";

type DataState = AppDataSnapshot & {
  isLoading: boolean;
  error: string | null;
};

type DataActions = {
  refresh: () => Promise<void>;
  queryMovements: (query: MovementQuery) => Promise<MovementPage>;
  createTemporaryVisitor: (input: CreateTemporaryVisitorInput) => Promise<Person>;
  createEmployee: (input: CreateEmployeeInput) => Promise<Person>;
  createHardwareAsset: (input: CreateHardwareAssetInput) => Promise<HardwareAsset>;
  updatePerson: (
    personId: string,
    patch: Partial<Omit<Person, "id">>
  ) => Promise<Person>;
  updateHardwareAsset: (
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ) => Promise<HardwareAsset>;
  updateAlert: (
    alertId: string,
    patch: Partial<Omit<Alert, "id">>
  ) => Promise<Alert>;
  updateAccessPermission: (
    input: UpdateAccessPermissionInput
  ) => Promise<AccessPermission>;
  decidePermissionRequest: (
    requestId: string,
    decision: "approved" | "denied",
    reason: string
  ) => Promise<PermissionRequest>;
  updateAlertRule: (ruleId: string, enabled: boolean) => Promise<AlertRule>;
  markNotificationRead: (notificationId: string) => Promise<PermissionNotification>;
  recordScan: (input: RecordScanInput) => ReturnType<DataService["recordScan"]>;
  saveMovement: (event: MovementEvent) => Promise<MovementEvent>;
  syncMovements: (eventIds?: string[]) => Promise<MovementEvent[]>;
  resolveMovementConflicts: (eventIds: string[]) => Promise<MovementEvent[]>;
  addMovementNote: (eventId: string, note: string) => Promise<string[]>;
};

const emptyData: AppDataSnapshot = {
  people: [],
  hardwareAssets: [],
  checkpoints: [],
  movements: [],
  alerts: [],
  scanAnalytics: {
    totalScans: 0,
    totalApproved: 0,
    totalDenied: 0,
    totalEntries: 0,
    totalExits: 0,
    totalAutomatic: 0,
    totalManual: 0,
    totalRestricted: 0,
    totalExpired: 0,
    totalOtherDenied: 0,
    activeInside: 0,
  },
  movementNotes: {},
  permissions: [],
  permissionRequests: [],
  notifications: [],
  alertRules: [],
  auditEvents: [],
};

const DataStateContext = createContext<DataState | null>(null);
const DataActionsContext = createContext<DataActions | null>(null);

function mergeById<T extends { id: string }>(current: T[], updates: T[]) {
  if (updates.length === 0) return current;
  const updateById = new Map(updates.map((item) => [item.id, item]));
  const merged = current.map((item) => updateById.get(item.id) ?? item);
  const existingIds = new Set(current.map((item) => item.id));
  return [
    ...updates.filter((item) => !existingIds.has(item.id)),
    ...merged,
  ];
}

function addMovementToAnalytics(
  analytics: AppDataSnapshot["scanAnalytics"],
  movement: MovementEvent,
  updatedPeople: Person[]
) {
  const approved = movement.result === "approved";
  const restricted =
    movement.denialCode === "asset_restricted" ||
    movement.denialCode === "access_restricted" ||
    movement.denialCode === "hardware_restricted" ||
    movement.denialCode === "zone_not_permitted";
  const expired = movement.denialCode === "expired_pass";
  const personPresenceDelta =
    approved && updatedPeople.length > 0
      ? movement.direction === "entry"
        ? 1
        : -1
      : 0;

  return {
    ...analytics,
    totalScans: analytics.totalScans + 1,
    totalApproved: analytics.totalApproved + Number(approved),
    totalDenied: analytics.totalDenied + Number(!approved),
    totalEntries:
      analytics.totalEntries +
      Number(approved && movement.direction === "entry"),
    totalExits:
      analytics.totalExits +
      Number(approved && movement.direction === "exit"),
    totalAutomatic:
      analytics.totalAutomatic + Number(movement.scanType === "auto"),
    totalManual:
      analytics.totalManual + Number(movement.scanType !== "auto"),
    totalRestricted: analytics.totalRestricted + Number(!approved && restricted),
    totalExpired: analytics.totalExpired + Number(!approved && expired),
    totalOtherDenied:
      analytics.totalOtherDenied +
      Number(!approved && !restricted && !expired),
    activeInside: Math.max(0, analytics.activeInside + personPresenceDelta),
  };
}

function scopeForPath(pathname: string): DataScope {
  if (pathname.startsWith("/terminal")) return "terminal";
  if (pathname.startsWith("/admin/dashboard")) return "dashboard";
  if (pathname.startsWith("/admin/logs")) return "logs";
  if (pathname.startsWith("/admin/registry")) return "registry";
  if (pathname.startsWith("/admin/permissions")) return "permissions";
  if (pathname.startsWith("/admin/alerts")) return "alerts";
  if (pathname.startsWith("/admin/profile")) return "profile";
  return "all";
}

export function DataProvider({
  children,
  service,
  initialData,
  initialScope,
}: {
  children: ReactNode;
  service: DataService;
  initialData?: AppDataSnapshot;
  initialScope?: DataScope;
}) {
  const pathname = usePathname();
  const scope = scopeForPath(pathname);
  const [state, setState] = useState<DataState>(() => ({
    ...(initialData ?? emptyData),
    isLoading: !initialData,
    error: null,
  }));
  const hydratedScope = useRef(initialData ? initialScope ?? scope : undefined);

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const snapshot = await service.getSnapshot(scope);
      setState({
        ...snapshot,
        isLoading: false,
        error: null,
      });
    } catch (error) {
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
      return;
    }
    setState({ ...emptyData, isLoading: true, error: null });
    void refresh();
  }, [refresh, scope]);

  const queryMovements = useCallback(
    (query: MovementQuery) => service.queryMovements(query),
    [service]
  );

  const createTemporaryVisitor = useCallback(
    async (input: CreateTemporaryVisitorInput) => {
      const visitor = await service.createTemporaryVisitor(input);
      setState((current) => ({
        ...current,
        people: [visitor, ...current.people],
      }));
      return visitor;
    },
    [service]
  );

  const createEmployee = useCallback(
    async (input: CreateEmployeeInput) => {
      const employee = await service.createEmployee(input);
      setState((current) => ({
        ...current,
        people: [employee, ...current.people],
      }));
      return employee;
    },
    [service]
  );

  const createHardwareAsset = useCallback(
    async (input: CreateHardwareAssetInput) => {
      const asset = await service.createHardwareAsset(input);
      setState((current) => ({
        ...current,
        hardwareAssets: [asset, ...current.hardwareAssets],
      }));
      return asset;
    },
    [service]
  );

  const updatePerson = useCallback(
    async (personId: string, patch: Partial<Omit<Person, "id">>) => {
      const updated = await service.updatePerson(personId, patch);
      setState((current) => ({
        ...current,
        people: current.people.map((person) =>
          person.id === updated.id ? updated : person
        ),
      }));
      return updated;
    },
    [service]
  );

  const updateHardwareAsset = useCallback(
    async (assetId: string, patch: Partial<Omit<HardwareAsset, "id">>) => {
      const updated = await service.updateHardwareAsset(assetId, patch);
      setState((current) => ({
        ...current,
        hardwareAssets: current.hardwareAssets.map((asset) =>
          asset.id === updated.id ? updated : asset
        ),
      }));
      return updated;
    },
    [service]
  );

  const updateAlert = useCallback(
    async (alertId: string, patch: Partial<Omit<Alert, "id">>) => {
      const updated = await service.updateAlert(alertId, patch);
      setState((current) => ({
        ...current,
        alerts: current.alerts.map((alert) =>
          alert.id === updated.id ? updated : alert
        ),
      }));
      return updated;
    },
    [service]
  );

  const updateAccessPermission = useCallback(
    async (input: UpdateAccessPermissionInput) => {
      const result = await service.updateAccessPermission(input);
      setState((current) => ({
        ...current,
        permissions: mergeById(current.permissions, [result.permission]),
        people: result.person
          ? mergeById(current.people, [result.person])
          : current.people,
        hardwareAssets: result.hardwareAsset
          ? mergeById(current.hardwareAssets, [result.hardwareAsset])
          : current.hardwareAssets,
        auditEvents: [result.auditEvent, ...current.auditEvents],
        notifications: [result.notification, ...current.notifications],
      }));
      return result.permission;
    },
    [service]
  );

  const decidePermissionRequest = useCallback(
    async (
      requestId: string,
      decision: "approved" | "denied",
      reason: string
    ) => {
      const result = await service.decidePermissionRequest(
        requestId,
        decision,
        reason
      );
      setState((current) => ({
        ...current,
        permissionRequests: mergeById(current.permissionRequests, [result.request]),
        permissions: result.permission
          ? mergeById(current.permissions, [result.permission])
          : current.permissions,
        people: result.person
          ? mergeById(current.people, [result.person])
          : current.people,
        hardwareAssets: result.hardwareAsset
          ? mergeById(current.hardwareAssets, [result.hardwareAsset])
          : current.hardwareAssets,
        auditEvents: result.auditEvent
          ? [result.auditEvent, ...current.auditEvents]
          : current.auditEvents,
        notifications: result.notification
          ? [result.notification, ...current.notifications]
          : current.notifications,
      }));
      return result.request;
    },
    [service]
  );

  const updateAlertRule = useCallback(
    async (ruleId: string, enabled: boolean) => {
      const updated = await service.updateAlertRule(ruleId, enabled);
      setState((current) => ({
        ...current,
        alertRules: current.alertRules.map((rule) =>
          rule.id === ruleId ? updated : rule
        ),
      }));
      return updated;
    },
    [service]
  );

  const markNotificationRead = useCallback(
    async (notificationId: string) => {
      const updated = await service.markNotificationRead(notificationId);
      setState((current) => ({
        ...current,
        notifications: current.notifications.map((notification) =>
          notification.id === notificationId ? updated : notification
        ),
      }));
      return updated;
    },
    [service]
  );

  const recordScan = useCallback(
    async (input: RecordScanInput) => {
      const result = await service.recordScan(input);
      setState((current) => {
        const movements = [result.decision.event, ...current.movements];
        return {
          ...current,
          people: mergeById(current.people, result.updatedPeople),
          hardwareAssets: mergeById(
            current.hardwareAssets,
            result.updatedHardwareAssets
          ),
          movements,
          alerts: [...result.generatedAlerts, ...current.alerts],
          scanAnalytics: addMovementToAnalytics(
            current.scanAnalytics,
            result.decision.event,
            result.updatedPeople
          ),
        };
      });
      return result;
    },
    [service]
  );

  const saveMovement = useCallback(
    async (event: MovementEvent) => {
      const saved = await service.saveMovement(event);
      setState((current) => {
        const exists = current.movements.some((movement) => movement.id === saved.id);
        const movements = exists
          ? current.movements.map((movement) =>
              movement.id === saved.id ? saved : movement
            )
          : [saved, ...current.movements];
        return {
          ...current,
          movements,
          scanAnalytics: getDashboardKPIs(movements, current.people),
        };
      });
      return saved;
    },
    [service]
  );

  const syncMovements = useCallback(
    async (eventIds?: string[]) => {
      const movements = await service.syncMovements(eventIds);
      setState((current) => ({
        ...current,
        movements: mergeById(current.movements, movements),
      }));
      return movements;
    },
    [service]
  );

  const resolveMovementConflicts = useCallback(
    async (eventIds: string[]) => {
      const movements = await service.resolveMovementConflicts(eventIds);
      setState((current) => ({
        ...current,
        movements: mergeById(current.movements, movements),
      }));
      return movements;
    },
    [service]
  );

  const addMovementNote = useCallback(
    async (eventId: string, note: string) => {
      const notes = await service.addMovementNote(eventId, note);
      setState((current) => ({
        ...current,
        movementNotes: { ...current.movementNotes, [eventId]: notes },
      }));
      return notes;
    },
    [service]
  );

  const actions = useMemo<DataActions>(
    () => ({
      refresh,
      queryMovements,
      createTemporaryVisitor,
      createEmployee,
      createHardwareAsset,
      updatePerson,
      updateHardwareAsset,
      updateAlert,
      updateAccessPermission,
      decidePermissionRequest,
      updateAlertRule,
      markNotificationRead,
      recordScan,
      saveMovement,
      syncMovements,
      resolveMovementConflicts,
      addMovementNote,
    }),
    [
      addMovementNote,
      createEmployee,
      createHardwareAsset,
      createTemporaryVisitor,
      queryMovements,
      recordScan,
      refresh,
      resolveMovementConflicts,
      saveMovement,
      syncMovements,
      updateAlert,
      updateAccessPermission,
      decidePermissionRequest,
      updateAlertRule,
      markNotificationRead,
      updateHardwareAsset,
      updatePerson,
    ]
  );

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
