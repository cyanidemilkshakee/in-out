import { useCallback, useMemo } from "react";
import type {
  AlertQuery,
  AuditEventQuery,
  AlertEvaluationResult,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateVisitorInput,
  HardwareAsset,
  MovementQuery,
  DashboardAnalyticsQuery,
  EmployeeActivityQuery,
  EmployeeActivitySummaryQuery,
  Person,
  PermissionRequest,
  PermissionRequestInput,
  RecordScanInput,
  TerminalVisitor,
} from "../../lib/types";
import type { DataActions, DataActionDependencies } from "./dataTypes";
import { mergeById } from "./dataHelpers";
import { mergePermissionRequests } from "../../lib/permissionRequestRevisions";
import { mergeAlerts } from "../../lib/alertRevisions";
import { applyPresenceUpdate } from "./presenceUpdates";
import { refreshOpenAlertCount } from "./activityEvents";

export function useDataActions({ service, setState, refresh }: DataActionDependencies): DataActions {
  // Always use a fresh authenticated no-store bundle, never IndexedDB policy.
  const loadTerminalReplayPolicy = useCallback<DataActions["loadTerminalReplayPolicy"]>(
    async () => (await service.getSnapshot("terminal")).terminalReplayPolicy, [service]);
  const queryRegistryPage = useCallback<DataActions["queryRegistryPage"]>((query, signal) => service.queryRegistryPage(query, signal), [service]);
  const queryRegistrySubjects = useCallback<DataActions["queryRegistrySubjects"]>((query, signal) => service.queryRegistrySubjects(query, signal), [service]);
  const querySubjectProfile = useCallback<DataActions["querySubjectProfile"]>((subjectId, signal) => service.querySubjectProfile(subjectId, signal), [service]);
  const queryDashboardAnalytics = useCallback(
    (query: DashboardAnalyticsQuery, signal?: AbortSignal) => service.queryDashboardAnalytics(query, signal), [service]
  );
  const queryEmployeeActivity = useCallback(
    (query: EmployeeActivityQuery, signal?: AbortSignal) => service.queryEmployeeActivity(query, signal), [service]
  );
  const queryEmployeeActivitySummary = useCallback(
    (query: EmployeeActivitySummaryQuery, signal?: AbortSignal) => service.queryEmployeeActivitySummary(query, signal), [service]
  );
  const queryMovements = useCallback(
    (query: MovementQuery, signal?: AbortSignal) => service.queryMovements(query, signal),
    [service]
  );

  const createEmployee = useCallback(
    async (input: CreateEmployeeInput) => {
      const employee = await service.createEmployee(input);
      setState((current) => ({ ...current, people: mergeById(current.people, [employee]) }));
      // Refresh this page's scoped snapshot. Other admin scopes are refreshed
      // by the backend live event or when their route is opened.
      // Re-merge in case a read replica has not caught up with the write yet.
      await refresh();
      setState((current) => ({ ...current, people: mergeById(current.people, [employee]) }));
      return employee;
    },
    [service, setState, refresh]
  );

  const createHardwareAsset = useCallback(
    async (input: CreateHardwareAssetInput) => {
      const asset = await service.createHardwareAsset(input);
      setState((current) => ({ ...current, hardwareAssets: mergeById(current.hardwareAssets, [asset]) }));
      await refresh();
      setState((current) => ({ ...current, hardwareAssets: mergeById(current.hardwareAssets, [asset]) }));
      return asset;
    },
    [service, setState, refresh]
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

  const reviewAlert = useCallback(async (alertId: string, decision: "confirmed" | "excused", reason = "") => {
    const result = await service.reviewAlert(alertId, decision, reason);
    setState(current => ({ ...current, alerts: mergeAlerts(current.alerts, [result.alert]) }));
    refreshOpenAlertCount();
    await refresh();
    return result.alert;
  }, [service, setState, refresh]);

  const resetAlertWarnings = useCallback(async (subjectId: string, reason: string) => {
    await service.resetAlertWarnings(subjectId, reason);
    refreshOpenAlertCount();
    await refresh();
  }, [service, refresh]);

  const setAlertRuleAssignments = useCallback(async (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision?: number) => {
    const result = await service.setAlertRuleAssignments(subjectId, ruleIds, irregularitySkipDates, expectedRevision);
    await refresh();
    return result;
  }, [service, refresh]);

  const submitPermissionRequest = useCallback(
    async (request: Omit<PermissionRequest, "id" | "status" | "createdAt">) => {
      const result = await service.submitPermissionRequest(request);
      setState((current) => ({ ...current, permissionRequests: mergePermissionRequests(current.permissionRequests, [result]) }));
      return result;
    },
    [service, setState]
  );

  const grantPermission = useCallback(async (input: PermissionRequestInput) => {
    const result = await service.grantPermission(input);
    setState(current => ({ ...current,
      permissionRequests: mergePermissionRequests(current.permissionRequests, [result.request]),
      permissions: result.permission ? mergeById(current.permissions, [result.permission]) : current.permissions,
      people: result.person ? mergeById(current.people, [result.person]) : current.people,
      hardwareAssets: result.hardwareAssets?.length ? mergeById(current.hardwareAssets, result.hardwareAssets)
        : result.hardwareAsset ? mergeById(current.hardwareAssets, [result.hardwareAsset]) : current.hardwareAssets,
      auditEvents: result.auditEvent ? mergeById(current.auditEvents, [result.auditEvent]) : current.auditEvents,
    }));
    await refresh();
    return result.request;
  }, [service, setState, refresh]);

  const releaseEntryRestriction = useCallback(async (alertId: string, reason: string) => {
    await service.releaseEntryRestriction(alertId, reason);
    await refresh();
  }, [service, refresh]);

  const decidePermissionRequest = useCallback(
    async (requestId: string, decision: "approved" | "denied", reason: string, validForMinutes?: number) => {
      const result = await service.decidePermissionRequest(requestId, decision, reason, validForMinutes);
      setState((current) => {
        const permissionRequests = mergePermissionRequests(current.permissionRequests, [result.request]);
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
        };
      });
      await refresh();
      return result.request;
    },
    [service, setState, refresh]
  );

  const queryAlerts = useCallback(
    (query: AlertQuery, signal?: AbortSignal) => service.queryAlerts(query, signal),
    [service]
  );

  const queryAlertRuleAssignments = useCallback(
    (subjectId: string, signal?: AbortSignal) => service.queryAlertRuleAssignments(subjectId, signal),
    [service]
  );

  const queryAuditEvents = useCallback(
    (query: AuditEventQuery, signal?: AbortSignal) => service.queryAuditEvents(query, signal),
    [service]
  );

  const createVisitor = useCallback(
    async (input: CreateVisitorInput) => {
      const result = await service.createVisitor(input);
      const terminalVisitor: TerminalVisitor = {
        id: result.visitor.id,
        name: result.visitor.name,
        barcode: result.visitor.barcode,
        host: result.visitor.host ?? input.host,
        company: result.visitor.company ?? input.company,
        allowedZones: input.allowedZones ?? result.request.requestedZones ?? result.visitor.allowedZones ?? [],
        validFrom: result.visitor.validFrom ?? input.validFrom,
        validTo: result.visitor.validTo ?? input.validTo,
        createdAt: result.visitor.createdAt ?? result.request.createdAt,
        status: "pending",
      };
      setState((current) => ({
        ...current,
        people: mergeById(current.people, [result.visitor]),
        permissionRequests: mergePermissionRequests(current.permissionRequests, [result.request]),
        terminalVisitors: current.terminalAssignment?.checkpointId === input.checkpointId &&
          !current.terminalVisitors.some((visitor) => visitor.id === terminalVisitor.id)
          ? [terminalVisitor, ...current.terminalVisitors]
          : current.terminalVisitors,
      }));
      await refresh();
      setState((current) => ({
        ...current,
        people: mergeById(current.people, [result.visitor]),
        permissionRequests: mergePermissionRequests(current.permissionRequests, [result.request]),
        terminalVisitors: current.terminalAssignment?.checkpointId === input.checkpointId &&
          !current.terminalVisitors.some((visitor) => visitor.id === terminalVisitor.id)
          ? [terminalVisitor, ...current.terminalVisitors]
          : current.terminalVisitors,
      }));
      return result;
    },
    [service, setState, refresh]
  );

  const dismissPermissionNotification = useCallback(
    async (requestId: string) => {
      const request = await service.dismissPermissionNotification(requestId);
      setState((current) => ({ ...current, permissionRequests: mergePermissionRequests(current.permissionRequests, [request]) }));
      return request;
    },
    [service, setState]
  );

  const evaluateAlertRules = useCallback(async (): Promise<AlertEvaluationResult> => {
    const result = await service.evaluateAlertRules();
    refreshOpenAlertCount();
    await refresh();
    return result;
  }, [refresh, service]);

  const recordScan = useCallback(
    async (input: RecordScanInput, idempotencyKey?: string) => {
      const result = await service.recordScan(input, idempotencyKey);
      // Retry receipts contain historical subjects and events. Applying them
      // can undo a newer exit/transfer after the event leaves the retained list.
      if (result.replayed || result.decision.replayed) return result;
      setState((current) => {
        return {
          ...applyPresenceUpdate(current, {
            movement: result.decision.event,
            people: result.updatedPeople,
            hardwareAssets: result.updatedHardwareAssets,
          }),
          permissionRequests: result.manualApprovalRequest
            ? mergePermissionRequests(current.permissionRequests, [result.manualApprovalRequest])
            : current.permissionRequests,
        };
      });
      return result;
    },
    [service, setState]
  );

  const requestBarcodeManualReview = useCallback(
    async (input: BarcodeManualReviewInput) => {
      const result = await service.requestBarcodeManualReview(input);
      setState((current) => ({ ...current, permissionRequests: mergePermissionRequests(current.permissionRequests, [result]) }));
      return result;
    },
    [service, setState]
  );

  return useMemo(
    () => ({
      loadTerminalReplayPolicy,
      queryRegistryPage, queryRegistrySubjects, querySubjectProfile,
      refresh,
      queryMovements,
      queryDashboardAnalytics,
      queryEmployeeActivity,
      queryEmployeeActivitySummary,
      queryAlerts,
      queryAlertRuleAssignments,
      queryAuditEvents,
      createEmployee,
      createVisitor,
      createHardwareAsset,
      updatePerson,
      updateHardwareAsset,
      reviewAlert,
      resetAlertWarnings,
      setAlertRuleAssignments,
      submitPermissionRequest,
      grantPermission,
      releaseEntryRestriction,
      decidePermissionRequest,
      dismissPermissionNotification,
      evaluateAlertRules,
      recordScan,
      requestBarcodeManualReview,
    }),
    [
      loadTerminalReplayPolicy,
      queryRegistryPage, queryRegistrySubjects, querySubjectProfile,
      createEmployee,
      createVisitor,
      createHardwareAsset,
      dismissPermissionNotification,
      decidePermissionRequest,
      evaluateAlertRules,
      queryMovements,
      queryDashboardAnalytics,
      queryEmployeeActivity,
      queryEmployeeActivitySummary,
      queryAlerts,
      queryAlertRuleAssignments,
      queryAuditEvents,
      recordScan,
      requestBarcodeManualReview,
      refresh,
      submitPermissionRequest,
      grantPermission,
      releaseEntryRestriction,
      reviewAlert,
      resetAlertWarnings,
      setAlertRuleAssignments,
      updateHardwareAsset,
      updatePerson,
    ]
  );
}
