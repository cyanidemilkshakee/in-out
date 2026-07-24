export type Role = "admin" | "security";

export type SubjectType = "employee" | "visitor" | "hardware";

export type Direction = "entry" | "exit";

export type ResultStatus = "approved" | "denied";

export type SyncState = "synced" | "queued" | "conflict";

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
