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
  | "already_inside"
  | "no_active_entry"
  | "asset_not_expected_out"
  | "manual_review";

export type VisibleColumn =
  | "date"
  | "time"
  | "createdAt"
  | "name"
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
  department?: string;
  company?: string;
  phone: string;
  accessLevel: string;
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
};

export type SubjectRecord = Person | HardwareAsset;

export type Checkpoint = {
  id: string;
  name: string;
  mode: "auto" | "manual" | "entry" | "exit";
  zone: string;
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
};

export type Alert = {
  id: string;
  severity: "critical" | "high" | "medium";
  status: "open" | "acknowledged" | "resolved";
  title: string;
  reason: string;
  subjectName: string;
  barcode: string;
  checkpoint: string;
  date: string;
  time: string;
  category?:
    | "access_violation"
    | "presence_anomaly"
    | "hardware_custody"
    | "operational";
  ruleId?: string;
  explanation?: string;
  sourceEventId?: string;
  createdAt?: string;
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
};

export type PermissionRequest = {
  id: string;
  type: "visitor" | "hardware_custody";
  subjectId: string;
  subjectName: string;
  requester: string;
  purpose: string;
  requestedZones: string[];
  validFrom: string;
  validTo: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  hardwareId?: string;
  carrierId?: string;
  carrierName?: string;
};

export type PermissionNotification = {
  id: string;
  title: string;
  message: string;
  category: "approval_request" | "permission_change" | "rule_trigger";
  priority: "high" | "normal";
  relatedId: string;
  href: string;
  createdAt: string;
  read: boolean;
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
    | "exit_balance"
    | "no_break"
    | "unauthorized_hardware_carrier"
    | "restricted_employee_entry";
  recentTriggers: number;
};

export type AuditEvent = {
  id: string;
  category: "movement" | "alert" | "permission";
  action: string;
  subjectId: string;
  subjectName: string;
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
  notifications: PermissionNotification[];
  alertRules: AlertRule[];
  auditEvents: AuditEvent[];
};

export type CreateTemporaryVisitorInput = {
  name: string;
  barcode: string;
  company: string;
  host: string;
  hours: number;
  validFrom: string;
  validUntil: string;
  reason: string;
};

export type CreateEmployeeInput = {
  name: string;
  barcode: string;
  department: string;
  accessLevel: string;
  allowedZone: string;
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
  selectedHardwareIds: string[];
  online: boolean;
  scanType: "auto" | "manual";
};

export type RecordScanResult = {
  decision: ScanDecision;
  updatedPeople: Person[];
  updatedHardwareAssets: HardwareAsset[];
  generatedAlerts: Alert[];
};

export type UpdateAccessPermissionInput = {
  subjectId: string;
  state: AccessPermission["state"];
  zones?: string[];
  validFrom?: string;
  validTo?: string;
  reason: string;
};

export type AccessPermissionMutationResult = {
  permission: AccessPermission;
  person?: Person;
  hardwareAsset?: HardwareAsset;
  auditEvent: AuditEvent;
  notification: PermissionNotification;
};

export type PermissionDecisionMutationResult = {
  request: PermissionRequest;
  permission?: AccessPermission;
  person?: Person;
  hardwareAsset?: HardwareAsset;
  auditEvent?: AuditEvent;
  notification?: PermissionNotification;
};

export type MovementQuery = {
  page: number;
  pageSize: number;
  search?: string;
  checkpoint?: string;
  result?: ResultStatus;
  scanType?: "auto" | "manual";
  direction?: Direction;
  subjectGroup?: "people" | "hardware";
  startAt?: string;
  endAt?: string;
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

export interface DataService {
  getSnapshot(scope?: DataScope): Promise<AppDataSnapshot>;
  queryMovements(query: MovementQuery): Promise<MovementPage>;
  createTemporaryVisitor(input: CreateTemporaryVisitorInput): Promise<Person>;
  createEmployee(input: CreateEmployeeInput): Promise<Person>;
  createHardwareAsset(input: CreateHardwareAssetInput): Promise<HardwareAsset>;
  updatePerson(personId: string, patch: Partial<Omit<Person, "id">>): Promise<Person>;
  updateHardwareAsset(
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ): Promise<HardwareAsset>;
  updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>): Promise<Alert>;
  updateAccessPermission(
    input: UpdateAccessPermissionInput
  ): Promise<AccessPermissionMutationResult>;
  decidePermissionRequest(
    requestId: string,
    decision: "approved" | "denied",
    reason: string
  ): Promise<PermissionDecisionMutationResult>;
  updateAlertRule(ruleId: string, enabled: boolean): Promise<AlertRule>;
  markNotificationRead(notificationId: string): Promise<PermissionNotification>;
  recordScan(input: RecordScanInput): Promise<RecordScanResult>;
  saveMovement(event: MovementEvent): Promise<MovementEvent>;
  syncMovements(eventIds?: string[]): Promise<MovementEvent[]>;
  resolveMovementConflicts(eventIds: string[]): Promise<MovementEvent[]>;
  addMovementNote(eventId: string, note: string): Promise<string[]>;
}
