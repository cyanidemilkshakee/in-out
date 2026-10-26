import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  AlertPage,
  AlertQuery,
  AuditEventPage,
  AuditEventQuery,
  Alert,
  AlertEvaluationResult,
  AlertRuleAssignment,
  AlertRuleAssignmentDirectory,
  AppDataSnapshot,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateVisitorInput,
  CreateVisitorResult,
  DataScope,
  DataService,
  DashboardAnalytics,
  DashboardAnalyticsQuery,
  EmployeeActivity,
  EmployeeActivityQuery,
  EmployeeActivitySummary,
  EmployeeActivitySummaryQuery,
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
  loadTerminalReplayPolicy: () => Promise<AppDataSnapshot["terminalReplayPolicy"]>;
  queryRegistryPage: DataService["queryRegistryPage"];
  queryRegistrySubjects: DataService["queryRegistrySubjects"];
  querySubjectProfile: DataService["querySubjectProfile"];
  loadMoreTerminalVisitors: (cursor?: string) => Promise<void>;
  refresh: () => Promise<void>;
  queryMovements: (query: MovementQuery, signal?: AbortSignal) => Promise<MovementPage>;
  queryDashboardAnalytics: (query: DashboardAnalyticsQuery, signal?: AbortSignal) => Promise<DashboardAnalytics>;
  queryEmployeeActivity: (query: EmployeeActivityQuery, signal?: AbortSignal) => Promise<EmployeeActivity>;
  queryEmployeeActivitySummary: (query: EmployeeActivitySummaryQuery, signal?: AbortSignal) => Promise<EmployeeActivitySummary>;
  queryAlerts: (query: AlertQuery, signal?: AbortSignal) => Promise<AlertPage>;
  queryAlertRuleAssignments: (subjectId: string, signal?: AbortSignal) => Promise<AlertRuleAssignmentDirectory>;
  queryAuditEvents: (query: AuditEventQuery, signal?: AbortSignal) => Promise<AuditEventPage>;
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
};

export type DataActionDependencies = {
  service: DataService;
  setState: Dispatch<SetStateAction<DataState>>;
  refresh: () => Promise<void>;
};

export type DataProviderProps = {
  clientManaged?: boolean;
  children: ReactNode;
  service: DataService;
  initialData?: AppDataSnapshot;
  initialScope?: DataScope;
};
