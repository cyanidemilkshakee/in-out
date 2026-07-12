export type Role = "admin" | "security";

export type SubjectType = "employee" | "visitor" | "hardware";

export type Direction = "entry" | "exit";

export type ResultStatus =
  | "success"
  | "denied"
  | "duplicate"
  | "expired"
  | "restricted"
  | "manual_review"
  | "pending";

export type SyncState = "synced" | "queued" | "conflict";

export type CheckpointMode = "entry" | "exit" | "auto";

export type VisibleColumn =
  | "time"
  | "checkpoint"
  | "direction"
  | "subject"
  | "type"
  | "barcode"
  | "result"
  | "reason"
  | "scanner"
  | "sync";

export type SortDirection = "asc" | "desc";

export type RoleRecord = {
  id: string;
  name: string;
  permissions: string[];
};

export type UserRecord = {
  id: string;
  roleId: string;
  email: string;
  displayName: string;
  status: "active" | "suspended";
};

export type EmployeeRecord = {
  id: string;
  userId: string;
  shiftPolicyId: string;
  employeeCode: string;
  name: string;
  department: string;
  status: "active" | "inactive";
  createdAt: string;
};

export type ShiftPolicy = {
  id: string;
  name: string;
  rules: string[];
  status: "active" | "draft" | "retired";
};

export type ActivePresence = {
  id: string;
  employeeId?: string;
  visitorId?: string;
  hardwareItemId?: string;
  checkpointId: string;
  movementTransactionId: string;
  state: "inside" | "outside" | "held";
  enteredAt: string;
};

export type OfflineSyncBatch = {
  id: string;
  deviceId: string;
  checkpointId: string;
  status: "received" | "replayed" | "conflict";
  receivedAt: string;
  resolvedAt?: string;
  conflictCount: number;
};

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
  status: "active" | "inactive" | "pre_approved" | "expired";
  host?: string;
  purpose?: string;
  validFrom?: string;
  validTo?: string;
  inside: boolean;
};

export type HardwareAsset = {
  id: string;
  name: string;
  barcode: string;
  owner: string;
  category: string;
  allowedZones: string[];
  status: "active" | "restricted" | "maintenance";
  inside: boolean;
};

export type SubjectRecord = Person | HardwareAsset;

export type Checkpoint = {
  id: string;
  name: string;
  mode: CheckpointMode;
  zone: string;
  scannerId: string;
  online: boolean;
};

export type Scanner = {
  id: string;
  name: string;
  checkpointId: string;
  status: "online" | "offline" | "warning";
  lastSeen: string;
  version: string;
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
  time: string;
  checkpointId: string;
  checkpoint: string;
  direction: Direction;
  subjectId: string;
  subjectName: string;
  subjectType: SubjectType;
  barcode: string;
  result: ResultStatus;
  reason: string;
  scannerId: string;
  syncState: SyncState;
  hardwareIds: string[];
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
  time: string;
};

export type ScanDecision = {
  event: MovementEvent;
  subject?: SubjectRecord;
  carriedHardware: HardwareAsset[];
};
