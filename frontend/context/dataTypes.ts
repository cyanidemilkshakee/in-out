import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  AlertPage,
  AlertQuery,
  AuditEventPage,
  AuditEventQuery,
  Alert,
  AlertEvaluationResult,
  AlertRuleAssignment,
  AppDataSnapshot,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateVisitorInput,
  CreateVisitorResult,
  DataScope,
  DataService,
  HardwareAsset,
  MovementPage,
  MovementQuery,
  Person,
  PermissionRequest,
  PermissionRequestInput,
  RecordScanInput,
} from "../../lib/types";

export type DataState = AppDataSnapshot & {
  isLoading: boolean;
  error: string | null;
};

export type DataActions = {
  refresh: () => Promise<void>;
  queryMovements: (query: MovementQuery) => Promise<MovementPage>;
  queryAlerts: (query: AlertQuery) => Promise<AlertPage>;
  queryAuditEvents: (query: AuditEventQuery) => Promise<AuditEventPage>;
  createEmployee: (input: CreateEmployeeInput) => Promise<Person>;
  createVisitor: (input: CreateVisitorInput) => Promise<CreateVisitorResult>;
  createHardwareAsset: (input: CreateHardwareAssetInput) => Promise<HardwareAsset>;
  updatePerson: (
    personId: string,
    patch: Partial<Omit<Person, "id">>
  ) => Promise<Person>;
  updateHardwareAsset: (
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ) => Promise<HardwareAsset>;
  acknowledgeAlert: (alertId: string) => Promise<Alert>;
  reviewAlert: (alertId: string, decision: "confirmed" | "excused", reason?: string) => Promise<Alert>;
  resetAlertWarnings: (subjectId: string, reason: string) => Promise<void>;
  setAlertRuleAssignments: (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision?: number) => Promise<AlertRuleAssignment>;
  submitPermissionRequest: (
    request: Omit<PermissionRequest, "id" | "status" | "createdAt">
  ) => Promise<PermissionRequest>;
  decidePermissionRequest: (
    requestId: string,
    decision: "approved" | "denied",
    reason: string,
    validForMinutes?: number
  ) => Promise<PermissionRequest>;
  grantPermission: (input: PermissionRequestInput) => Promise<PermissionRequest>;
  releaseEntryRestriction: (alertId: string, reason: string) => Promise<void>;
  dismissPermissionNotification: (requestId: string) => Promise<PermissionRequest>;
  recordScan: (input: RecordScanInput, idempotencyKey?: string) => ReturnType<DataService["recordScan"]>;
  evaluateAlertRules: () => Promise<AlertEvaluationResult>;
  requestBarcodeManualReview: (
    input: BarcodeManualReviewInput
  ) => ReturnType<DataService["requestBarcodeManualReview"]>;
  addMovementNote: (eventId: string, note: string) => Promise<string[]>;
};

export type DataActionDependencies = {
  service: DataService;
  setState: Dispatch<SetStateAction<DataState>>;
  refresh: () => Promise<void>;
};

export type DataProviderProps = {
  children: ReactNode;
  service: DataService;
  initialData?: AppDataSnapshot;
  initialScope?: DataScope;
};
