import { getDashboardKPIs } from "../lib/analyticsUtils";
import {
  checkpoints,
  hardwareAssets,
  initialAlerts,
  initialMovements,
  people,
} from "../lib/mockData";
import { applyMovementState, evaluateScan } from "../lib/movementLogic";
import type { Alert, HardwareAsset, MovementEvent, Person } from "../lib/types";
import type {
  AppDataSnapshot,
  CreateTemporaryVisitorInput,
  DataService,
  MovementNotes,
  RecordScanInput,
  RecordScanResult,
} from "./dataService";

function clonePeople(items: Person[]) {
  return items.map((item) => ({ ...item, allowedZones: [...item.allowedZones] }));
}

function cloneHardware(items: HardwareAsset[]) {
  return items.map((item) => ({ ...item, allowedZones: [...item.allowedZones] }));
}

function cloneMovements(items: MovementEvent[]) {
  return items.map((item) => ({ ...item, hardwareIds: [...item.hardwareIds] }));
}

function cloneAlerts(items: Alert[]) {
  return items.map((item) => ({ ...item }));
}

function cloneNotes(notes: MovementNotes) {
  return Object.fromEntries(
    Object.entries(notes).map(([eventId, entries]) => [eventId, [...entries]])
  );
}

export function createMockDataSnapshot(): AppDataSnapshot {
  const movements = cloneMovements(initialMovements);
  return {
    people: clonePeople(people),
    hardwareAssets: cloneHardware(hardwareAssets),
    checkpoints: checkpoints.map((item) => ({ ...item })),
    movements,
    alerts: cloneAlerts(initialAlerts),
    scanAnalytics: getDashboardKPIs(movements),
    movementNotes: {},
  };
}

export class MockDataService implements DataService {
  private people: Person[];
  private hardwareAssets: HardwareAsset[];
  private checkpoints: AppDataSnapshot["checkpoints"];
  private movements: MovementEvent[];
  private alerts: Alert[];
  private movementNotes: MovementNotes;

  constructor(initialData: AppDataSnapshot = createMockDataSnapshot()) {
    this.people = clonePeople(initialData.people);
    this.hardwareAssets = cloneHardware(initialData.hardwareAssets);
    this.checkpoints = initialData.checkpoints.map((item) => ({ ...item }));
    this.movements = cloneMovements(initialData.movements);
    this.alerts = cloneAlerts(initialData.alerts);
    this.movementNotes = cloneNotes(initialData.movementNotes);
  }

  async getPeople() {
    return clonePeople(this.people);
  }

  async getHardwareAssets() {
    return cloneHardware(this.hardwareAssets);
  }

  async getCheckpoints() {
    return this.checkpoints.map((item) => ({ ...item }));
  }

  async getMovements() {
    return cloneMovements(this.movements);
  }

  async getAlerts() {
    return cloneAlerts(this.alerts);
  }

  async getScanAnalytics() {
    return getDashboardKPIs(this.movements);
  }

  async getMovementNotes() {
    return cloneNotes(this.movementNotes);
  }

  async createTemporaryVisitor(input: CreateTemporaryVisitorInput) {
    let suffix = String(Math.floor(1000 + Math.random() * 9000));
    while (this.people.some((person) => person.id === `vis-temp-${suffix}`)) {
      suffix = String(Math.floor(1000 + Math.random() * 9000));
    }

    const hours = Math.min(24, Math.max(1, input.hours));
    const now = new Date();
    const requestedStart = new Date(input.validFrom);
    const requestedEnd = new Date(input.validUntil);
    const start = Number.isNaN(requestedStart.getTime()) || requestedStart < now
      ? now
      : requestedStart;
    const maximumEnd = start.getTime() + 24 * 60 * 60 * 1000;
    const fallbackEnd = start.getTime() + hours * 60 * 60 * 1000;
    const requestedEndTime = requestedEnd.getTime();
    const end = new Date(
      Number.isNaN(requestedEndTime) || requestedEndTime <= start.getTime()
        ? fallbackEnd
        : Math.min(requestedEndTime, maximumEnd)
    );
    const visitor: Person = {
      id: `vis-temp-${suffix}`,
      name: input.name.trim() || `Temporary Visitor ${suffix}`,
      type: "visitor",
      barcode: `V-TEMP-${suffix}`,
      company: input.company.trim() || "Walk-in",
      phone: "+91 00000 00000",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "pre_approved",
      host: input.host.trim() || "Security Desk",
      purpose: input.reason.trim() || "Temporary visit",
      validFrom: start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      validTo: end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      inside: false,
    };

    this.people = [visitor, ...this.people];
    return clonePeople([visitor])[0];
  }

  async updatePerson(personId: string, patch: Partial<Omit<Person, "id">>) {
    const existing = this.people.find((person) => person.id === personId);
    if (!existing) throw new Error(`Person ${personId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.people = this.people.map((person) => (person.id === personId ? updated : person));
    return clonePeople([updated])[0];
  }

  async updateHardwareAsset(
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ) {
    const existing = this.hardwareAssets.find((asset) => asset.id === assetId);
    if (!existing) throw new Error(`Hardware asset ${assetId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.hardwareAssets = this.hardwareAssets.map((asset) =>
      asset.id === assetId ? updated : asset
    );
    return cloneHardware([updated])[0];
  }

  async updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>) {
    const existing = this.alerts.find((alert) => alert.id === alertId);
    if (!existing) throw new Error(`Alert ${alertId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { ...updated };
  }

  async recordScan(input: RecordScanInput): Promise<RecordScanResult> {
    const checkpoint = this.checkpoints.find((item) => item.id === input.checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${input.checkpointId} was not found.`);

    const decision = evaluateScan({
      barcode: input.barcode,
      checkpoint,
      people: this.people,
      hardware: this.hardwareAssets,
      selectedHardwareIds: input.selectedHardwareIds,
      online: input.online,
      eventCount: this.movements.length + 1,
      scanType: input.scanType,
    });
    const nextState = applyMovementState(
      decision.event,
      this.people,
      this.hardwareAssets
    );

    this.people = nextState.people;
    this.hardwareAssets = nextState.hardware;
    this.movements = [decision.event, ...this.movements];

    return {
      decision: {
        ...decision,
        event: { ...decision.event, hardwareIds: [...decision.event.hardwareIds] },
        carriedHardware: cloneHardware(decision.carriedHardware),
      },
      people: clonePeople(this.people),
      hardwareAssets: cloneHardware(this.hardwareAssets),
    };
  }

  async saveMovement(event: MovementEvent) {
    const saved = { ...event, hardwareIds: [...event.hardwareIds] };
    const exists = this.movements.some((movement) => movement.id === event.id);
    this.movements = exists
      ? this.movements.map((movement) => (movement.id === event.id ? saved : movement))
      : [saved, ...this.movements];
    return { ...saved, hardwareIds: [...saved.hardwareIds] };
  }

  async syncMovements(eventIds?: string[]) {
    const selected = eventIds ? new Set(eventIds) : null;
    this.movements = this.movements.map((event) => {
      const shouldSync =
        event.syncState === "queued" && (!selected || selected.has(event.id));
      if (!shouldSync) return event;
      return {
        ...event,
        syncState: event.result === "approved" ? "synced" : "conflict",
      };
    });
    return cloneMovements(this.movements);
  }

  async resolveMovementConflicts(eventIds: string[]) {
    const selected = new Set(eventIds);
    this.movements = this.movements.map((event) =>
      event.syncState === "conflict" && selected.has(event.id)
        ? { ...event, syncState: "synced" }
        : event
    );
    return cloneMovements(this.movements);
  }

  async addMovementNote(eventId: string, note: string) {
    const trimmed = note.trim();
    if (!trimmed) return [...(this.movementNotes[eventId] ?? [])];
    const notes = [...(this.movementNotes[eventId] ?? []), trimmed];
    this.movementNotes = { ...this.movementNotes, [eventId]: notes };
    return [...notes];
  }
}
