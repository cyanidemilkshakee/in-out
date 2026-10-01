import { useCallback, useMemo } from "react";
import type {
  AlertEvaluationResult,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  HardwareAsset,
  MovementQuery,
  Person,
  PermissionRequest,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../../lib/types";
import type { DataActions, DataActionDependencies } from "./dataTypes";
import { mergeById } from "./dataHelpers";
import { applyPresenceUpdate } from "./presenceUpdates";

export function useDataActions({ service, setState, refresh }: DataActionDependencies): DataActions {
  const queryMovements = useCallback(
    (query: MovementQuery) => service.queryMovements(query),
    [service]
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

  const acknowledgeAlert = useCallback(
    async (alertId: string) => {
      const updated = await service.acknowledgeAlert(alertId);
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
      setState((current) => ({ ...current, permissionRequests: mergeById(current.permissionRequests, [result]) }));
      return result;
    },
    [service, setState]
  );

  const decidePermissionRequest = useCallback(
    async (requestId: string, decision: "approved" | "denied", reason: string, validForMinutes?: number) => {
      const result = await service.decidePermissionRequest(requestId, decision, reason, validForMinutes);
      setState((current) => {
        const permissionRequests = mergeById(current.permissionRequests, [result.request]);
        const permissions = result.permission ? mergeById(current.permissions, [result.permission]) : current.permissions;
        const people = result.person ? mergeById(current.people, [result.person]) : current.people;
        const hardwareAssets = result.hardwareAsset ? mergeById(current.hardwareAssets, [result.hardwareAsset]) : current.hardwareAssets;
        const updated = applyPresenceUpdate(current, {
          movement: result.movement ?? undefined,
          people: result.person ? [result.person] : [],
          hardwareAssets: result.hardwareAssets ?? (result.hardwareAsset ? [result.hardwareAsset] : []),
        });
        return {
          ...current,
          permissionRequests,
          permissions,
          people: result.movement ? updated.people : people,
          hardwareAssets: result.movement ? updated.hardwareAssets : hardwareAssets,
          movements: updated.movements,
          scanAnalytics: updated.scanAnalytics,
          auditEvents: result.auditEvent ? mergeById(current.auditEvents, [result.auditEvent]) : current.auditEvents,
          notifications: result.notification ? [result.notification, ...current.notifications] : current.notifications,
        };
      });
      return result.request;
    },
    [service, setState]
  );

  const acknowledgePermissionRequest = useCallback(
    async (requestId: string) => {
      const request = await service.acknowledgePermissionRequest(requestId);
      setState((current) => ({ ...current, permissionRequests: mergeById(current.permissionRequests, [request]) }));
      return request;
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

  const evaluateAlertRules = useCallback(async (): Promise<AlertEvaluationResult> => {
    const result = await service.evaluateAlertRules();
    await refresh();
    return result;
  }, [refresh, service]);

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
    async (input: RecordScanInput, idempotencyKey?: string) => {
      const result = await service.recordScan(input, idempotencyKey);
      setState((current) => {
        return {
          ...applyPresenceUpdate(current, {
            movement: result.decision.event,
            people: result.updatedPeople,
            hardwareAssets: result.updatedHardwareAssets,
          }),
        };
      });
      return result;
    },
    [service, setState]
  );

  const requestBarcodeManualReview = useCallback(
    async (input: BarcodeManualReviewInput) => {
      const result = await service.requestBarcodeManualReview(input);
      setState((current) => ({ ...current, permissionRequests: mergeById(current.permissionRequests, [result]) }));
      return result;
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
      createEmployee,
      createHardwareAsset,
      updatePerson,
      updateHardwareAsset,
      acknowledgeAlert,
      updateAccessPermission,
      submitPermissionRequest,
      decidePermissionRequest,
      acknowledgePermissionRequest,
      updateAlertRule,
      evaluateAlertRules,
      markNotificationRead,
      recordScan,
      requestBarcodeManualReview,
      addMovementNote,
    }),
    [
      addMovementNote,
      createEmployee,
      createHardwareAsset,
      acknowledgePermissionRequest,
      decidePermissionRequest,
      evaluateAlertRules,
      markNotificationRead,
      queryMovements,
      recordScan,
      requestBarcodeManualReview,
      refresh,
      submitPermissionRequest,
      updateAccessPermission,
      acknowledgeAlert,
      updateAlertRule,
      updateHardwareAsset,
      updatePerson,
    ]
  );
}
