import type {
  AccessPermissionMutationResult,
  Alert,
  AlertEvaluationResult,
  AlertRule,
  BarcodeManualReviewInput,
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  DataScope,
  DataService,
  HardwareAsset,
  MovementPage,
  MovementQuery,
  Person,
  PermissionNotification,
  PermissionDecisionMutationResult,
  PermissionRequest,
  RecordScanInput,
  RecordScanResult,
  UpdateAccessPermissionInput,
} from "../lib/types";

type Command =
  | { action: "createEmployee"; input: CreateEmployeeInput }
  | { action: "createHardwareAsset"; input: CreateHardwareAssetInput }
  | { action: "updatePerson"; personId: string; patch: Partial<Omit<Person, "id">> }
  | { action: "updateHardwareAsset"; assetId: string; patch: Partial<Omit<HardwareAsset, "id">> }
  | { action: "acknowledgeAlert"; alertId: string }
  | { action: "updateAccessPermission"; input: UpdateAccessPermissionInput }
  | { action: "submitPermissionRequest"; request: Omit<PermissionRequest, 'id' | 'status' | 'createdAt'> }

  | {
      action: "decidePermissionRequest";
      requestId: string;
      decision: "approved" | "denied";
      reason: string;
      validForMinutes?: number;
    }
  | { action: "acknowledgePermissionRequest"; requestId: string }
  | { action: "updateAlertRule"; ruleId: string; enabled: boolean }
  | { action: "evaluateAlertRules" }
  | { action: "markNotificationRead"; notificationId: string }
  | { action: "recordScan"; input: RecordScanInput }
  | { action: "requestBarcodeManualReview"; input: BarcodeManualReviewInput }
  | { action: "addMovementNote"; eventId: string; note: string };

export class DataServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DataServiceError";
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | null;
  if (!response.ok) {
    throw new DataServiceError(body?.error ?? `Backend request failed with status ${response.status}.`, response.status);
  }
  if (!body || !("data" in body)) {
    throw new Error("Backend returned an invalid response.");
  }
  return body.data as T;
}

export class HttpDataService implements DataService {
  async getSnapshot(scope: DataScope = "all") {
    const response = await fetch(`/api/data?scope=${encodeURIComponent(scope)}`, {
      cache: "no-store",
    });
    return readResponse<AppDataSnapshot>(response);
  }

  async queryMovements(query: MovementQuery) {
    const params = new URLSearchParams({
      resource: "movements",
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    for (const [key, value] of Object.entries(query)) {
      if (
        key !== "page" &&
        key !== "pageSize" &&
        value !== undefined &&
        value !== ""
      ) {
        params.set(key, String(value));
      }
    }
    const response = await fetch(`/api/data?${params.toString()}`, {
      cache: "no-store",
    });
    return readResponse<MovementPage>(response);
  }

  private async command<T>(command: Command, idempotencyKey = crypto.randomUUID()) {
    const response = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(command),
    });
    return readResponse<T>(response);
  }

  createEmployee(input: CreateEmployeeInput) {
    return this.command<Person>({ action: "createEmployee", input });
  }

  createHardwareAsset(input: CreateHardwareAssetInput) {
    return this.command<HardwareAsset>({ action: "createHardwareAsset", input });
  }

  updatePerson(personId: string, patch: Partial<Omit<Person, "id">>) {
    return this.command<Person>({ action: "updatePerson", personId, patch });
  }

  updateHardwareAsset(assetId: string, patch: Partial<Omit<HardwareAsset, "id">>) {
    return this.command<HardwareAsset>({ action: "updateHardwareAsset", assetId, patch });
  }

  acknowledgeAlert(alertId: string) {
    return this.command<Alert>({ action: "acknowledgeAlert", alertId });
  }

  updateAccessPermission(input: UpdateAccessPermissionInput) {
    return this.command<AccessPermissionMutationResult>({
      action: "updateAccessPermission",
      input,
    });
  }


  submitPermissionRequest(request: Omit<PermissionRequest, 'id' | 'status' | 'createdAt'>) {
    return this.command<PermissionRequest>({
      action: "submitPermissionRequest",
      request,
    });
  }

  decidePermissionRequest(
    requestId: string,
    decision: "approved" | "denied",
    reason: string,
    validForMinutes?: number
  ) {
    return this.command<PermissionDecisionMutationResult>({
      action: "decidePermissionRequest",
      requestId,
      decision,
      reason,
      validForMinutes,
    });
  }

  acknowledgePermissionRequest(requestId: string) {
    return this.command<PermissionRequest>({ action: "acknowledgePermissionRequest", requestId });
  }

  updateAlertRule(ruleId: string, enabled: boolean) {
    return this.command<AlertRule>({ action: "updateAlertRule", ruleId, enabled });
  }

  evaluateAlertRules() {
    return this.command<AlertEvaluationResult>({ action: "evaluateAlertRules" });
  }

  markNotificationRead(notificationId: string) {
    return this.command<PermissionNotification>({
      action: "markNotificationRead",
      notificationId,
    });
  }

  recordScan(input: RecordScanInput, idempotencyKey?: string) {
    return this.command<RecordScanResult>({ action: "recordScan", input }, idempotencyKey);
  }

  requestBarcodeManualReview(input: BarcodeManualReviewInput) {
    return this.command<PermissionRequest>({ action: "requestBarcodeManualReview", input });
  }

  addMovementNote(eventId: string, note: string) {
    return this.command<string[]>({ action: "addMovementNote", eventId, note });
  }
}
