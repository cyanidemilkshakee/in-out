import type {
  AccessPermissionMutationResult,
  Alert,
  AlertRule,
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataScope,
  DataService,
  HardwareAsset,
  MovementEvent,
  MovementPage,
  MovementQuery,
  Person,
  PermissionNotification,
  PermissionDecisionMutationResult,
  RecordScanInput,
  RecordScanResult,
  UpdateAccessPermissionInput,
} from "../lib/types";

type Command =
  | { action: "createTemporaryVisitor"; input: CreateTemporaryVisitorInput }
  | { action: "createEmployee"; input: CreateEmployeeInput }
  | { action: "createHardwareAsset"; input: CreateHardwareAssetInput }
  | { action: "updatePerson"; personId: string; patch: Partial<Omit<Person, "id">> }
  | { action: "updateHardwareAsset"; assetId: string; patch: Partial<Omit<HardwareAsset, "id">> }
  | { action: "updateAlert"; alertId: string; patch: Partial<Omit<Alert, "id">> }
  | { action: "updateAccessPermission"; input: UpdateAccessPermissionInput }
  | {
      action: "decidePermissionRequest";
      requestId: string;
      decision: "approved" | "denied";
      reason: string;
    }
  | { action: "updateAlertRule"; ruleId: string; enabled: boolean }
  | { action: "markNotificationRead"; notificationId: string }
  | { action: "recordScan"; input: RecordScanInput }
  | { action: "saveMovement"; event: MovementEvent }
  | { action: "syncMovements"; eventIds?: string[] }
  | { action: "resolveMovementConflicts"; eventIds: string[] }
  | { action: "addMovementNote"; eventId: string; note: string };

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Backend request failed with status ${response.status}.`);
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

  private async command<T>(command: Command) {
    const response = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    return readResponse<T>(response);
  }

  createTemporaryVisitor(input: CreateTemporaryVisitorInput) {
    return this.command<Person>({ action: "createTemporaryVisitor", input });
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

  updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>) {
    return this.command<Alert>({ action: "updateAlert", alertId, patch });
  }

  updateAccessPermission(input: UpdateAccessPermissionInput) {
    return this.command<AccessPermissionMutationResult>({
      action: "updateAccessPermission",
      input,
    });
  }

  decidePermissionRequest(
    requestId: string,
    decision: "approved" | "denied",
    reason: string
  ) {
    return this.command<PermissionDecisionMutationResult>({
      action: "decidePermissionRequest",
      requestId,
      decision,
      reason,
    });
  }

  updateAlertRule(ruleId: string, enabled: boolean) {
    return this.command<AlertRule>({ action: "updateAlertRule", ruleId, enabled });
  }

  markNotificationRead(notificationId: string) {
    return this.command<PermissionNotification>({
      action: "markNotificationRead",
      notificationId,
    });
  }

  recordScan(input: RecordScanInput) {
    return this.command<RecordScanResult>({ action: "recordScan", input });
  }

  saveMovement(event: MovementEvent) {
    return this.command<MovementEvent>({ action: "saveMovement", event });
  }

  syncMovements(eventIds?: string[]) {
    return this.command<MovementEvent[]>({ action: "syncMovements", eventIds });
  }

  resolveMovementConflicts(eventIds: string[]) {
    return this.command<MovementEvent[]>({ action: "resolveMovementConflicts", eventIds });
  }

  addMovementNote(eventId: string, note: string) {
    return this.command<string[]>({ action: "addMovementNote", eventId, note });
  }
}
