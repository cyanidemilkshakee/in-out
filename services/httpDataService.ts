import type {
  AlertPage,
  AlertQuery,
  AuditEventPage,
  AuditEventQuery,
  Alert,
  AlertEvaluationResult,
  AlertRuleAssignment,
  AlertRuleAssignmentDirectory,
  BarcodeManualReviewInput,
  AppDataSnapshot,
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
  PermissionDecisionMutationResult,
  PermissionRequest,
  PermissionRequestInput,
  EntryRestriction,
  RecordScanInput,
  RecordScanResult,
  RegistryPage, RegistryPageQuery, RegistrySubjectPage, RegistrySubjectQuery, SubjectProfile,
  TerminalVisitorPage,
} from "../lib/types";

type Command =
  | { action: "createEmployee"; input: CreateEmployeeInput }
  | { action: "createVisitor"; input: CreateVisitorInput }
  | { action: "createHardwareAsset"; input: CreateHardwareAssetInput }
  | { action: "updatePerson"; personId: string; patch: Partial<Omit<Person, "id">> }
  | { action: "updateHardwareAsset"; assetId: string; patch: Partial<Omit<HardwareAsset, "id">> }
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
  | { action: "requestBarcodeManualReview"; input: BarcodeManualReviewInput };

export class DataServiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DataServiceError";
  }
}

let authRedirectStarted = false;

function redirectToLoginAfterSessionExpiry() {
  if (authRedirectStarted || typeof window === "undefined") return;
  authRedirectStarted = true;
  const currentPath = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?from=${encodeURIComponent(currentPath)}`);
}

async function readResponse<T>(response: Response, signal?: AbortSignal): Promise<T> {
  const body = (await response.json().catch((error: unknown) => {
    // A superseded read may be cancelled after its headers have arrived.
    // Preserve that cancellation rather than reporting malformed JSON.
    if (signal?.aborted) throw signal.reason;
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return null;
  })) as
    | { data?: T; error?: string }
    | null;
  if (!response.ok) {
    if (response.status === 401) redirectToLoginAfterSessionExpiry();
    throw new DataServiceError(body?.error ?? `Backend request failed with status ${response.status}.`, response.status);
  }
  if (!body || !("data" in body)) {
    throw new Error("Backend returned an invalid response.");
  }
  return body.data as T;
}

function resourceParams(
  resource: string,
  query: object,
  initial: Record<string, string> = {},
  excludedKeys: readonly string[] = []
) {
  const params = new URLSearchParams({ resource, ...initial });
  for (const [key, value] of Object.entries(query)) {
    if (!excludedKeys.includes(key) && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  return params;
}

export class HttpDataService implements DataService {
  async queryDashboardAnalytics(query: DashboardAnalyticsQuery, signal?: AbortSignal): Promise<DashboardAnalytics> {
    const params = resourceParams("dashboardAnalytics", query);
    return readResponse<DashboardAnalytics>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async queryEmployeeActivity(query: EmployeeActivityQuery, signal?: AbortSignal): Promise<EmployeeActivity> {
    const params = resourceParams("employeeActivity", query);
    return readResponse<EmployeeActivity>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async queryEmployeeActivitySummary(query: EmployeeActivitySummaryQuery, signal?: AbortSignal): Promise<EmployeeActivitySummary> {
    const params = resourceParams("employeeActivitySummary", query);
    return readResponse<EmployeeActivitySummary>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async queryOpenAlertCount(signal?: AbortSignal): Promise<number> {
    return readResponse<number>(await fetch("/api/data?resource=openAlertCount", { cache: "no-store", signal }), signal);
  }

  async getSnapshot(scope: DataScope = "all", signal?: AbortSignal) {
    const response = await fetch(`/api/data?scope=${encodeURIComponent(scope)}`, {
      cache: "no-store",
      signal,
    });
    return readResponse<AppDataSnapshot>(response, signal);
  }

  async queryMovements(query: MovementQuery, signal?: AbortSignal) {
    const params = resourceParams("movements", query, {
      page: String(query.page),
      pageSize: String(query.pageSize),
    }, ["page", "pageSize"]);
    const response = await fetch(`/api/data?${params.toString()}`, {
      cache: "no-store",
      signal,
    });
    return readResponse<MovementPage>(response, signal);
  }

  async queryAuditEvents(query: AuditEventQuery, signal?: AbortSignal) {
    const params = resourceParams("auditEvents", query, {
      limit: String(query.limit),
      offset: String(query.offset),
    }, ["limit", "offset"]);
    const response = await fetch(`/api/data?${params.toString()}`, { cache: "no-store", signal });
    return readResponse<AuditEventPage>(response, signal);
  }

  async queryAlerts(query: AlertQuery, signal?: AbortSignal) {
    const params = resourceParams("alerts", query, {
      limit: String(query.limit),
      offset: String(query.offset),
    }, ["limit", "offset"]);
    const response = await fetch(`/api/data?${params.toString()}`, { cache: "no-store", signal });
    return readResponse<AlertPage>(response, signal);
  }

  async queryAlertRuleAssignments(subjectId: string, signal?: AbortSignal): Promise<AlertRuleAssignmentDirectory> {
    const params = new URLSearchParams({ resource: "alertRuleAssignments", subjectId });
    const response = await fetch(`/api/data?${params.toString()}`, { cache: "no-store", signal });
    return readResponse<AlertRuleAssignmentDirectory>(response, signal);
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

  async queryRegistryPage(query: RegistryPageQuery, signal?: AbortSignal) {
    const params = resourceParams("registryPage", query);
    return readResponse<RegistryPage>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async queryRegistrySubjects(query: RegistrySubjectQuery, signal?: AbortSignal) {
    const params = resourceParams("registrySubjects", query);
    return readResponse<RegistrySubjectPage>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async querySubjectProfile(subjectId: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ resource: "subjectProfile", subjectId });
    return readResponse<SubjectProfile>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

  async queryTerminalVisitors(cursor?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ resource: "terminalVisitors" });
    if (cursor) params.set("cursor", cursor);
    return readResponse<TerminalVisitorPage>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
  }

}
