export type Role = "admin" | "security";

export type SubjectType = "employee" | "visitor" | "hardware";

export type Direction = "entry" | "exit";

export type ResultStatus = "approved" | "denied";

export type SyncState = "synced" | "queued" | "conflict";

export type DenialCode =
  | "barcode_not_registered"
  | "asset_restricted"
  | "access_restricted"
  | "access_inactive"
  | "expired_pass"
  | "approval_pending"
  | "not_preapproved"
  | "hardware_restricted"
  | "custody_mismatch"
  | "zone_not_permitted"
  | "cross_building_access"
  | "already_inside"
  | "no_active_entry"
  | "asset_not_expected_out"
  | "manual_review";

export type VisibleColumn =
  | "date"
  | "time"
  | "createdAt"
  | "name"
  | "active"
  | "type"
  | "direction"
  | "checkpoint"
  | "result"
  | "barcode"
  | "scanType"
  | "eventId";

export type SortDirection = "asc" | "desc";

export type Person = {
  id: string;
  name: string;
  type: Exclude<SubjectType, "hardware">;
  barcode: string;
  company?: string;
  phone?: string;
  allowedZones: string[];
  status:
    | "active"
    | "inactive"
    | "pre_approved"
    | "pending_approval"
    | "restricted"
    | "expired";
  host?: string;
  purpose?: string;
  validFrom?: string;
  validTo?: string;
  inside: boolean;
  createdAt?: string;
  entryRestriction?: EntryRestriction;
};

export type HardwareAsset = {
  id: string;
  name: string;
  barcode: string;
  owner: string;
  assignedEmployeeId?: string;
  assignedEmployeeName?: string;
  category: string;
  allowedZones: string[];
  status: "active" | "restricted" | "maintenance";
  inside: boolean;
  createdAt?: string;
  entryRestriction?: EntryRestriction;
};

export type SubjectRecord = Person | HardwareAsset;

export type EntryRestriction = {
  subjectId: string;
  active: boolean;
  triggeredAt: string;
  triggerAlertId: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseReason?: string;
};

export type Checkpoint = {
  id: string;
  name: string;
  mode: "auto" | "manual" | "entry" | "exit";
  zone: string;
  buildingId?: string;
  online: boolean;
  createdAt?: string;
};

export type ScanAnalytics = {
  totalScans: number;
  totalApproved: number;
  totalDenied: number;
  totalEntries: number;
  totalExits: number;
  totalAutomatic: number;
  totalManual: number;
  totalRestricted: number;
  totalExpired: number;
  totalOtherDenied: number;
  activeInside: number;
};

export type MovementEvent = {
  id: string;
  date: string;
  time: string;
  checkpointId: string;
  checkpoint: string;
  direction: Direction;
  subjectId: string;
  subjectName: string;
  subjectType: SubjectType;
  barcode: string;
  result: ResultStatus;
  reason?: string;
  denialCode?: DenialCode;
  scanType?: "auto" | "manual";
  syncState: SyncState;
  hardwareIds: string[];
  createdAt?: string;
  capturedOfflineAt?: string;
  source?: "paper_register";
  paperReference?: string;
  loggedAt?: string;
  historicalVisitId?: string;
  manualReviewedAt?: string;
  overrideRequestId?: string;
  manualApprovalRequestId?: string;
};

export type Alert = {
  id: string;
  severity: "critical" | "high" | "medium";
  status: "open" | "acknowledged" | "warned" | "resolved";
  title: string;
  reason: string;
  subjectName: string;
  barcode: string;
  checkpoint: string;
  date: string;
  time: string;
  subjectType?: SubjectType;
  category?:
    | "access_violation"
    | "presence_anomaly"
    | "hardware_custody"
    | "operational";
  ruleId?: string;
  explanation?: string;
  sourceEventId?: string;
  createdAt?: string;
  subjectId?: string;
  review?: AlertReview;
  warningCount?: number;
  warningResetAt?: string;
  warningResetBy?: string;
  warningResetReason?: string;
  warningReset?: { resetAt: string; resetBy: string; reason: string };
  entryRestriction?: EntryRestriction;
};

export type AlertReview = {
  decision: "confirmed" | "excused";
  reason: string;
  reviewedAt: string;
  reviewedBy: string;
};

export type AlertWarningSummary = {
  subjectId: string;
  subjectName: string;
  subjectType: "employee" | "hardware";
  barcode: string;
  count: number;
  resetAt?: string;
  resetBy?: string;
  resetReason?: string;
  entryRestriction?: EntryRestriction;
};

export type AlertRuleAssignment = {
  subjectId: string;
  subjectName: string;
  subjectType: "employee" | "hardware";
  barcode: string;
  ruleIds: string[];
  irregularitySkipDates: string[];
  source: "default" | "custom";
  revision: number;
};

export type AlertEvaluationResult = {
  triggered: number;
  message: string;
};

export type AccessState =
  | "active"
  | "restricted"
  | "pending_approval"
  | "expired"
  | "revoked";

export type AccessPermission = {
  id: string;
  subjectId: string;
  subjectName: string;
  subjectType: SubjectType;
  assignment: string;
  state: AccessState;
  zones: string[];
  validFrom: string;
  validTo: string;
  source: "policy" | "manual" | "request";
  reason?: string;
  updatedAt: string;
  updatedBy: string;
  entryRestriction?: EntryRestriction;
};

export type PermissionRequest = {
  id: string;
  type: "visitor" | "hardware_custody" | "manual_override" | "zone_access";
  subjectId: string;
  subjectName: string;
  requester: string;
  purpose: string;
  requestedZones: string[];
  validFrom: string;
  validTo: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  barcode?: string;
  hardwareId?: string;
  carrierId?: string;
  carrierName?: string;
  checkpointId?: string;
  checkpoint?: string;
  direction?: Direction;
  eventId?: string;
  operatorNote?: string;
  decisionReason?: string;
  notificationDismissedAt?: string;
  notificationDismissedBy?: string;
  decidedAt?: string;
  consumedAt?: string;
  consumedMovementId?: string;
  consumedBy?: string;
  previousCarrierId?: string;
  previousCarrierName?: string;
  previousZones?: string[];
  previousValidFrom?: string;
  previousValidTo?: string;
};

export type PermissionRequestInput = Omit<PermissionRequest, "id" | "status" | "createdAt"> & {
  newVisitor?: { name: string; host: string; company?: string };
  permanentAccess?: boolean;
};

export type AlertRule = {
  id: string;
  name: string;
  description: string;
  category: NonNullable<Alert["category"]>;
  severity: Alert["severity"];
  enabled: boolean;
  scope: string;
  conditionKey:
    | "no_break"
    | "irregularity";
  recentTriggers: number;
  eligibleSubjectTypes?: Array<"employee" | "hardware">;
};

export type AuditEvent = {
  id: string;
  category: "movement" | "alert" | "permission";
  action: string;
  subjectId: string;
  subjectName: string;
  barcode?: string;
  actor: string;
  role: string;
  decision?: "granted" | "denied";
  reason: string;
  relatedId: string;
  date: string;
  time: string;
  createdAt: string;
};

export type WorkdayStatus = {
  employeeId: string;
  employeeName: string;
  date: string;
  breakMinutes: number;
  minutesInside: number;
  shiftEnded: boolean;
};

export type ScanDecision = {
  event: MovementEvent;
  subject?: SubjectRecord;
  carriedHardware: HardwareAsset[];
  entryRestrictions?: EntryRestriction[];
};

export type MovementNotes = Record<string, string[]>;

export type DataScope =
  | "dashboard"
  | "logs"
  | "registry"
  | "permissions"
  | "alerts"
  | "profile"
  | "terminal"
  | "all";

export type AppDataSnapshot = {
  people: Person[];
  hardwareAssets: HardwareAsset[];
  checkpoints: Checkpoint[];
  movements: MovementEvent[];
  movementPage?: MovementPage;
  alerts: Alert[];
  scanAnalytics: ScanAnalytics;
  movementNotes: MovementNotes;
  permissions: AccessPermission[];
  permissionRequests: PermissionRequest[];
  alertRules: AlertRule[];
  alertWarnings: AlertWarningSummary[];
  alertRuleAssignments: AlertRuleAssignment[];
  auditEvents: AuditEvent[];
  adminAvailability?: { status: "available" | "offline"; availableAt: string | null };
  terminalAssignment?: { operatorSubject: string; checkpointId: string | null };
};

export type CreateEmployeeInput = {
  name: string;
  barcode: string;
  allowedZone?: string;
  allowedZones?: string[];
};

export type CreateHardwareAssetInput = {
  name: string;
  barcode: string;
  owner: string;
  category: string;
  allowedZone: string;
  status: HardwareAsset["status"];
};

export type RecordScanInput = {
  barcode: string;
  checkpointId: string;
  direction?: Direction;
  selectedHardwareIds: string[];
  online: boolean;
  scanType: "auto" | "manual";
  capturedOfflineAt?: string;
};

export type BarcodeManualReviewInput = {
  barcode: string;
  checkpointId: string;
  direction?: Direction;
  eventId?: string;
  operatorNote: string;
};

export type CreateVisitorInput = {
  name: string;
  barcode: string;
  host: string;
  validFrom: string;
  validTo: string;
  checkpointId: string;
  allowedZones?: string[];
  company?: string;
  purpose?: string;
};

export type CreateVisitorResult = {
  visitor: Person;
  request: PermissionRequest;
};

export type RecordScanResult = {
  decision: ScanDecision;
  updatedPeople: Person[];
  updatedHardwareAssets: HardwareAsset[];
  manualApprovalRequest?: PermissionRequest;
};

export type PermissionDecisionMutationResult = {
  request: PermissionRequest;
  movement?: MovementEvent;
  permission?: AccessPermission;
  person?: Person;
  hardwareAsset?: HardwareAsset;
  hardwareAssets?: HardwareAsset[];
  auditEvent?: AuditEvent;
};

export type MovementQuery = {
  page: number;
  pageSize: number;
  subject_id?: string;
  eventId?: string;
  search?: string;
  checkpoint?: string;
  result?: ResultStatus;
  scanType?: "auto" | "manual";
  direction?: Direction;
  subjectGroup?: "people" | "hardware";
  startAt?: string;
  endAt?: string;
  includeChart?: boolean;
  sortKey?: VisibleColumn;
  sortDirection?: SortDirection;
};

export type MovementPage = {
  items: MovementEvent[];
  chartItems: MovementEvent[];
  movementNotes: MovementNotes;
  total: number;
  page: number;
  pageSize: number;
  checkpoints: string[];
};

export type AuditEventQuery = {
  limit: number;
  offset: number;
  category?: AuditEvent["category"];
  startAt?: string;
  endAt?: string;
};

export type AuditEventPage = {
  items: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
};

export type AlertQuery = {
  limit: number;
  offset: number;
  status?: Alert["status"] | "active";
  subjectId?: string;
  search?: string;
  startAt?: string;
  endAt?: string;
};

export type AlertPage = {
  items: Alert[];
  total: number;
  limit: number;
  offset: number;
  warnings?: AlertWarningSummary[];
};

export interface DataService {
  getSnapshot(scope?: DataScope): Promise<AppDataSnapshot>;
  queryOpenAlertCount(): Promise<number>;
  queryMovements(query: MovementQuery): Promise<MovementPage>;
  queryAlerts(query: AlertQuery): Promise<AlertPage>;
  queryAuditEvents(query: AuditEventQuery): Promise<AuditEventPage>;
  createEmployee(input: CreateEmployeeInput): Promise<Person>;
  createVisitor(input: CreateVisitorInput): Promise<CreateVisitorResult>;
  createHardwareAsset(input: CreateHardwareAssetInput): Promise<HardwareAsset>;
  updatePerson(personId: string, patch: Partial<Omit<Person, "id">>): Promise<Person>;
  updateHardwareAsset(
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ): Promise<HardwareAsset>;
  acknowledgeAlert(alertId: string): Promise<Alert>;
  reviewAlert(alertId: string, decision: AlertReview["decision"], reason?: string): Promise<{ alert: Alert }>;
  resetAlertWarnings(subjectId: string, reason: string): Promise<unknown>;
  setAlertRuleAssignments(subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision?: number): Promise<AlertRuleAssignment>;
  submitPermissionRequest(request: Omit<PermissionRequest, 'id' | 'status' | 'createdAt'>): Promise<PermissionRequest>;
  grantPermission(input: PermissionRequestInput): Promise<PermissionDecisionMutationResult>;
  releaseEntryRestriction(alertId: string, reason: string): Promise<{ entryRestriction: EntryRestriction }>;
  decidePermissionRequest(
    requestId: string,
    decision: "approved" | "denied",
    reason: string,
    validForMinutes?: number
  ): Promise<PermissionDecisionMutationResult>;
  dismissPermissionNotification(requestId: string): Promise<PermissionRequest>;
  recordScan(input: RecordScanInput, idempotencyKey?: string): Promise<RecordScanResult>;
  evaluateAlertRules(): Promise<AlertEvaluationResult>;
  requestBarcodeManualReview(input: BarcodeManualReviewInput): Promise<PermissionRequest>;
  addMovementNote(eventId: string, note: string): Promise<string[]>;
}
