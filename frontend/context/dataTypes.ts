import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  AccessPermission,
  Alert,
  AlertEvaluationResult,
  AlertRule,
  AppDataSnapshot,
  BarcodeManualReviewInput,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  DataScope,
  DataService,
  HardwareAsset,
  MovementPage,
  MovementQuery,
  Person,
  PermissionNotification,
  PermissionRequest,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../../lib/types";

export type DataState = AppDataSnapshot & {
  isLoading: boolean;
  error: string | null;
};

export type DataActions = {
  refresh: () => Promise<void>;
  queryMovements: (query: MovementQuery) => Promise<MovementPage>;
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
  acknowledgeAlert: (alertId: string) => Promise<Alert>;
  updateAccessPermission: (
    input: UpdateAccessPermissionInput
  ) => Promise<AccessPermission>;
  submitPermissionRequest: (
    request: Omit<PermissionRequest, "id" | "status" | "createdAt">
  ) => Promise<PermissionRequest>;
  decidePermissionRequest: (
    requestId: string,
    decision: "approved" | "denied",
    reason: string,
    validForMinutes?: number
  ) => Promise<PermissionRequest>;
  acknowledgePermissionRequest: (requestId: string) => Promise<PermissionRequest>;
  updateAlertRule: (ruleId: string, enabled: boolean) => Promise<AlertRule>;
  markNotificationRead: (notificationId: string) => Promise<PermissionNotification>;
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
