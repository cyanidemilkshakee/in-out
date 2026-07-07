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
  battery: number;
  version: string;
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
