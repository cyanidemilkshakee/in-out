import { useCallback, useMemo } from "react";
import { getDashboardKPIs } from "../../lib/analyticsUtils";
import type {
  Alert,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  HardwareAsset,
  MovementEvent,
  MovementQuery,
  Person,
  PermissionRequest,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../../lib/types";
import type { DataActions, DataActionDependencies } from "./dataTypes";
import { addMovementToAnalytics, mergeById } from "./dataHelpers";

export function useDataActions({ service, setState, refresh }: DataActionDependencies): DataActions {
  const queryMovements = useCallback(
    (query: MovementQuery) => service.queryMovements(query),
    [service]
  );

  const createTemporaryVisitor = useCallback(
    async (input: CreateTemporaryVisitorInput) => {
      const visitor = await service.createTemporaryVisitor(input);
      setState((current) => ({ ...current, people: [visitor, ...current.people] }));
      return visitor;
    },
    [service, setState]
  );

  const createEmployee = useCallback(
    async (input: CreateEmployeeInput) => {
      const employee = await service.createEmployee(input);
      setState((current) => ({ ...current, people: [employee, ...current.people] }));
      return employee;
    },
    [service, setState]
  );

  const createHardwareAsset = useCallback(
    async (input: CreateHardwareAssetInput) => {
      const asset = await service.createHardwareAsset(input);
      setState((current) => ({ ...current, hardwareAssets: [asset, ...current.hardwareAssets] }));
      return asset;
    },
    [service, setState]
  );

  const updatePerson = useCallback(
    async (personId: string, patch: Partial<Omit<Person, "id">>) => {
      const updated = await service.updatePerson(personId, patch);
      setState((current) => ({
        ...current,
        people: current.people.map((person) => person.id === updated.id ? updated : person),
      }));
      return updated;
    },
    [service, setState]
  );

  const updateHardwareAsset = useCallback(
    async (assetId: string, patch: Partial<Omit<HardwareAsset, "id">>) => {
      const updated = await service.updateHardwareAsset(assetId, patch);
      setState((current) => ({
        ...current,
        hardwareAssets: current.hardwareAssets.map((asset) => asset.id === updated.id ? updated : asset),
      }));
      return updated;
    },
    [service, setState]
  );

  const updateAlert = useCallback(
    async (alertId: string, patch: Partial<Omit<Alert, "id">>) => {
      const updated = await service.updateAlert(alertId, patch);
      setState((current) => ({
        ...current,
        alerts: current.alerts.map((alert) => alert.id === updated.id ? updated : alert),
      }));
      return updated;
    },
    [service, setState]
  );

  const updateAccessPermission = useCallback(
    async (input: UpdateAccessPermissionInput) => {
      const result = await service.updateAccessPermission(input);
      setState((current) => ({
        ...current,
        permissions: mergeById(current.permissions, [result.permission]),
        people: result.person ? mergeById(current.people, [result.person]) : current.people,
        hardwareAssets: result.hardwareAsset ? mergeById(current.hardwareAssets, [result.hardwareAsset]) : current.hardwareAssets,
        auditEvents: [result.auditEvent, ...current.auditEvents],
        notifications: [result.notification, ...current.notifications],
      }));
      return result.permission;
    },
    [service, setState]
  );

  const submitPermissionRequest = useCallback(
    async (request: Omit<PermissionRequest, "id" | "status" | "createdAt">) => {
      const result = await service.submitPermissionRequest(request);
      setState((current) => ({ ...current, permissionRequests: [result, ...current.permissionRequests] }));
      return result;
    },
    [service, setState]
  );

  const decidePermissionRequest = useCallback(
    async (requestId: string, decision: "approved" | "denied", reason: string) => {
      const result = await service.decidePermissionRequest(requestId, decision, reason);
      setState((current) => {
        const permissionRequests = mergeById(current.permissionRequests, [result.request]);
        const permissions = result.permission ? mergeById(current.permissions, [result.permission]) : current.permissions;
        const people = result.person ? mergeById(current.people, [result.person]) : current.people;
        const hardwareAssets = result.hardwareAsset ? mergeById(current.hardwareAssets, [result.hardwareAsset]) : current.hardwareAssets;
        const movements = result.movement ? mergeById(current.movements, [result.movement]) : current.movements;
        return {
          ...current,
          permissionRequests,
          permissions,
          people,
          hardwareAssets,
          movements,
          scanAnalytics: result.movement ? getDashboardKPIs(movements, people) : current.scanAnalytics,
          auditEvents: result.auditEvent ? [result.auditEvent, ...current.auditEvents] : current.auditEvents,
          notifications: result.notification ? [result.notification, ...current.notifications] : current.notifications,
        };
      });
      return result.request;
    },
    [service, setState]
  );

  const updateAlertRule = useCallback(
    async (ruleId: string, enabled: boolean) => {
      const updated = await service.updateAlertRule(ruleId, enabled);
      setState((current) => ({
        ...current,
        alertRules: current.alertRules.map((rule) => rule.id === ruleId ? updated : rule),
      }));
      return updated;
    },
    [service, setState]
  );

  const markNotificationRead = useCallback(
    async (notificationId: string) => {
      const updated = await service.markNotificationRead(notificationId);
      setState((current) => ({
        ...current,
        notifications: current.notifications.map((notification) => notification.id === notificationId ? updated : notification),
      }));
      return updated;
    },
    [service, setState]
  );

  const recordScan = useCallback(
    async (input: RecordScanInput) => {
      const result = await service.recordScan(input);
      setState((current) => {
        const movements = [result.decision.event, ...current.movements];
        return {
          ...current,
          people: mergeById(current.people, result.updatedPeople),
          hardwareAssets: mergeById(current.hardwareAssets, result.updatedHardwareAssets),
          movements,
          alerts: [...result.generatedAlerts, ...current.alerts],
          scanAnalytics: addMovementToAnalytics(current.scanAnalytics, result.decision.event, result.updatedPeople),
        };
      });
      return result;
    },
    [service, setState]
  );

  const requestBarcodeManualReview = useCallback(
    async (input: BarcodeManualReviewInput) => {
      const result = await service.requestBarcodeManualReview(input);
      setState((current) => ({ ...current, permissionRequests: [result, ...current.permissionRequests] }));
      return result;
    },
    [service, setState]
  );

  const saveMovement = useCallback(
    async (event: MovementEvent) => {
      const saved = await service.saveMovement(event);
      setState((current) => {
        const exists = current.movements.some((movement) => movement.id === saved.id);
        const movements = exists
          ? current.movements.map((movement) => movement.id === saved.id ? saved : movement)
          : [saved, ...current.movements];
        return { ...current, movements, scanAnalytics: getDashboardKPIs(movements, current.people) };
      });
      return saved;
    },
    [service, setState]
  );

  const syncMovements = useCallback(
    async (eventIds?: string[]) => {
      const movements = await service.syncMovements(eventIds);
      setState((current) => ({ ...current, movements: mergeById(current.movements, movements) }));
      return movements;
    },
    [service, setState]
  );

  const resolveMovementConflicts = useCallback(
    async (eventIds: string[]) => {
      const movements = await service.resolveMovementConflicts(eventIds);
      setState((current) => ({ ...current, movements: mergeById(current.movements, movements) }));
      return movements;
    },
    [service, setState]
  );

  const addMovementNote = useCallback(
    async (eventId: string, note: string) => {
      const notes = await service.addMovementNote(eventId, note);
      setState((current) => ({ ...current, movementNotes: { ...current.movementNotes, [eventId]: notes } }));
      return notes;
    },
    [service, setState]
  );

  return useMemo(
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
      submitPermissionRequest,
      decidePermissionRequest,
      updateAlertRule,
      markNotificationRead,
      recordScan,
      requestBarcodeManualReview,
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
      decidePermissionRequest,
      markNotificationRead,
      queryMovements,
      recordScan,
      requestBarcodeManualReview,
      refresh,
      resolveMovementConflicts,
      saveMovement,
      submitPermissionRequest,
      syncMovements,
      updateAccessPermission,
      updateAlert,
      updateAlertRule,
      updateHardwareAsset,
      updatePerson,
    ]
  );
}
