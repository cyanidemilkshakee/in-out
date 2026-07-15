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
  company: string;
  host: string;
  hours: number;
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
