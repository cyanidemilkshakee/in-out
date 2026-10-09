import type {
  AlertPage,
  AlertQuery,
  AuditEventPage,
  AuditEventQuery,
  Alert,
  AlertEvaluationResult,
  AlertRuleAssignment,
  BarcodeManualReviewInput,
  AppDataSnapshot,
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
  PermissionDecisionMutationResult,
  PermissionRequest,
  PermissionRequestInput,
  EntryRestriction,
  RecordScanInput,
  RecordScanResult,
} from "../lib/types";

type Command =
  | { action: "createEmployee"; input: CreateEmployeeInput }
  | { action: "createVisitor"; input: CreateVisitorInput }
  | { action: "createHardwareAsset"; input: CreateHardwareAssetInput }
  | { action: "updatePerson"; personId: string; patch: Partial<Omit<Person, "id">> }
  | { action: "updateHardwareAsset"; assetId: string; patch: Partial<Omit<HardwareAsset, "id">> }
  | { action: "acknowledgeAlert"; alertId: string }
  | { action: "reviewAlert"; alertId: string; decision: "confirmed" | "excused"; reason?: string }
  | { action: "resetAlertWarnings"; subjectId: string; reason: string }
  | { action: "setAlertRuleAssignments"; subjectId: string; ruleIds: string[]; irregularitySkipDates: string[]; expectedRevision?: number }
  | { action: "submitPermissionRequest"; request: Omit<PermissionRequest, 'id' | 'status' | 'createdAt'> }
  | { action: "grantPermission"; input: PermissionRequestInput }
  | { action: "releaseEntryRestriction"; alertId: string; reason: string }

  | {
      action: "decidePermissionRequest";
      requestId: string;
      decision: "approved" | "denied";
      reason: string;
      validForMinutes?: number;
    }
  | { action: "dismissPermissionNotification"; requestId: string }
  | { action: "evaluateAlertRules" }
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
  async queryOpenAlertCount(): Promise<number> {
    return readResponse<number>(await fetch("/api/data?resource=openAlertCount", { cache: "no-store" }));
  }

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

  async queryAuditEvents(query: AuditEventQuery) {
    const params = new URLSearchParams({
      resource: "auditEvents",
      limit: String(query.limit),
      offset: String(query.offset),
    });
    for (const [key, value] of Object.entries(query)) {
      if (key !== "limit" && key !== "offset" && value !== undefined && value !== "") {
        params.set(key, String(value));
      }
    }
    const response = await fetch(`/api/data?${params.toString()}`, { cache: "no-store" });
    return readResponse<AuditEventPage>(response);
  }

  async queryAlerts(query: AlertQuery) {
    const params = new URLSearchParams({
      resource: "alerts",
      limit: String(query.limit),
      offset: String(query.offset),
    });
    for (const [key, value] of Object.entries(query)) {
      if (key !== "limit" && key !== "offset" && value !== undefined && value !== "") {
        params.set(key, String(value));
      }
    }
    const response = await fetch(`/api/data?${params.toString()}`, { cache: "no-store" });
    return readResponse<AlertPage>(response);
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

  createVisitor(input: CreateVisitorInput) {
    return this.command<CreateVisitorResult>({ action: "createVisitor", input });
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

  reviewAlert(alertId: string, decision: "confirmed" | "excused", reason = "") {
    return this.command<{ alert: Alert }>({ action: "reviewAlert", alertId, decision, reason });
  }

  resetAlertWarnings(subjectId: string, reason: string) {
    return this.command<unknown>({ action: "resetAlertWarnings", subjectId, reason });
  }

  setAlertRuleAssignments(subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision?: number) {
    return this.command<AlertRuleAssignment>({ action: "setAlertRuleAssignments", subjectId, ruleIds, irregularitySkipDates, expectedRevision });
  }

  submitPermissionRequest(request: Omit<PermissionRequest, 'id' | 'status' | 'createdAt'>) {
    return this.command<PermissionRequest>({
      action: "submitPermissionRequest",
      request,
    });
  }

  grantPermission(input: PermissionRequestInput) {
    return this.command<PermissionDecisionMutationResult>({ action: "grantPermission", input });
  }

  releaseEntryRestriction(alertId: string, reason: string) {
    return this.command<{ entryRestriction: EntryRestriction }>({ action: "releaseEntryRestriction", alertId, reason });
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

  dismissPermissionNotification(requestId: string) {
    return this.command<PermissionRequest>({ action: "dismissPermissionNotification", requestId });
  }

  evaluateAlertRules() {
    return this.command<AlertEvaluationResult>({ action: "evaluateAlertRules" });
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
