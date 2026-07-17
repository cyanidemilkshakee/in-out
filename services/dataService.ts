import type {
  Alert,
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  Person,
  ScanAnalytics,
  ScanDecision,
} from "../lib/types";

export type MovementNotes = Record<string, string[]>;

export type AppDataSnapshot = {
  people: Person[];
  hardwareAssets: HardwareAsset[];
  checkpoints: Checkpoint[];
  movements: MovementEvent[];
  alerts: Alert[];
  scanAnalytics: ScanAnalytics;
  movementNotes: MovementNotes;
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
  people: Person[];
  hardwareAssets: HardwareAsset[];
};

export interface DataService {
  getPeople(): Promise<Person[]>;
  getHardwareAssets(): Promise<HardwareAsset[]>;
  getCheckpoints(): Promise<Checkpoint[]>;
  getMovements(): Promise<MovementEvent[]>;
  getAlerts(): Promise<Alert[]>;
  getScanAnalytics(): Promise<ScanAnalytics>;
  getMovementNotes(): Promise<MovementNotes>;

  createTemporaryVisitor(input: CreateTemporaryVisitorInput): Promise<Person>;
  createEmployee(input: CreateEmployeeInput): Promise<Person>;
  createHardwareAsset(input: CreateHardwareAssetInput): Promise<HardwareAsset>;
  updatePerson(personId: string, patch: Partial<Omit<Person, "id">>): Promise<Person>;
  updateHardwareAsset(
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ): Promise<HardwareAsset>;
  updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>): Promise<Alert>;
  recordScan(input: RecordScanInput): Promise<RecordScanResult>;
  saveMovement(event: MovementEvent): Promise<MovementEvent>;
  syncMovements(eventIds?: string[]): Promise<MovementEvent[]>;
  resolveMovementConflicts(eventIds: string[]): Promise<MovementEvent[]>;
  addMovementNote(eventId: string, note: string): Promise<string[]>;
}
