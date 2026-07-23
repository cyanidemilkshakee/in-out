"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getDashboardKPIs } from "../lib/analyticsUtils";
import type {
  AccessPermission,
  Alert,
  AlertRule,
  HardwareAsset,
  MovementEvent,
  Person,
  PermissionNotification,
  PermissionRequest,
} from "../lib/types";
import type {
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataService,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../services/dataService";

type DataState = AppDataSnapshot & {
  isLoading: boolean;
  error: string | null;
};

type DataActions = {
  refresh: () => Promise<void>;
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
    activeInside: 0,
  },
  movementNotes: {},
  permissions: [],
  permissionRequests: [],
  notifications: [],
  alertRules: [],
  auditEvents: [],
};

const DataServiceContext = createContext<DataService | null>(null);
const DataStateContext = createContext<DataState | null>(null);
const DataActionsContext = createContext<DataActions | null>(null);

export function DataProvider({
  children,
  service,
  initialData,
}: {
  children: ReactNode;
  service: DataService;
  initialData?: AppDataSnapshot;
}) {
  const [state, setState] = useState<DataState>(() => ({
    ...(initialData ?? emptyData),
    isLoading: !initialData,
    error: null,
  }));

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const [
        people,
        hardwareAssets,
        checkpoints,
        movements,
        alerts,
        scanAnalytics,
        movementNotes,
        permissions,
        permissionRequests,
        notifications,
        alertRules,
        auditEvents,
      ] = await Promise.all([
        service.getPeople(),
        service.getHardwareAssets(),
        service.getCheckpoints(),
        service.getMovements(),
        service.getAlerts(),
        service.getScanAnalytics(),
        service.getMovementNotes(),
        service.getPermissions(),
        service.getPermissionRequests(),
        service.getNotifications(),
        service.getAlertRules(),
        service.getAuditEvents(),
      ]);
      setState({
        people,
        hardwareAssets,
        checkpoints,
        movements,
        alerts,
        scanAnalytics,
        movementNotes,
        permissions,
        permissionRequests,
        notifications,
        alertRules,
        auditEvents,
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
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createTemporaryVisitor = useCallback(
    async (input: CreateTemporaryVisitorInput) => {
      const visitor = await service.createTemporaryVisitor(input);
      await refresh();
      return visitor;
    },
    [refresh, service]
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
      const updated = await service.updateAccessPermission(input);
      await refresh();
      return updated;
    },
    [refresh, service]
  );

  const decidePermissionRequest = useCallback(
    async (
      requestId: string,
      decision: "approved" | "denied",
      reason: string
    ) => {
      const updated = await service.decidePermissionRequest(requestId, decision, reason);
      await refresh();
      return updated;
    },
    [refresh, service]
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
      await refresh();
      return result;
    },
    [refresh, service]
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
          scanAnalytics: getDashboardKPIs(movements),
        };
      });
      return saved;
    },
    [service]
  );

  const syncMovements = useCallback(
    async (eventIds?: string[]) => {
      const movements = await service.syncMovements(eventIds);
      setState((current) => ({ ...current, movements }));
      return movements;
    },
    [service]
  );

  const resolveMovementConflicts = useCallback(
    async (eventIds: string[]) => {
      const movements = await service.resolveMovementConflicts(eventIds);
      setState((current) => ({ ...current, movements }));
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
    <DataServiceContext.Provider value={service}>
      <DataActionsContext.Provider value={actions}>
        <DataStateContext.Provider value={state}>{children}</DataStateContext.Provider>
      </DataActionsContext.Provider>
    </DataServiceContext.Provider>
  );
}

export function useDataService() {
  const service = useContext(DataServiceContext);
  if (!service) throw new Error("useDataService must be used within DataProvider.");
  return service;
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
