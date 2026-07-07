import type {
  Checkpoint,
  Direction,
  HardwareAsset,
  MovementEvent,
  Person,
  ResultStatus,
  ScanDecision,
  SubjectRecord,
  SyncState
} from "./types";

type ScanInput = {
  barcode: string;
  checkpoint: Checkpoint;
  people: Person[];
  hardware: HardwareAsset[];
  selectedHardwareIds: string[];
  online: boolean;
  eventCount: number;
};

function isHardware(subject: SubjectRecord): subject is HardwareAsset {
  return "category" in subject;
}

function currentTime() {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
}

function directionFor(checkpoint: Checkpoint, subject?: SubjectRecord): Direction {
  if (checkpoint.mode === "entry") {
    return "entry";
  }
  if (checkpoint.mode === "exit") {
    return "exit";
  }
  return subject?.inside ? "exit" : "entry";
}

function zoneAllowed(subject: SubjectRecord, checkpoint: Checkpoint) {
  if (subject.allowedZones.includes("All Zones")) {
    return true;
  }
  return subject.allowedZones.includes(checkpoint.zone) || subject.allowedZones.includes(checkpoint.name);
}

function statusFor(subject: SubjectRecord | undefined, checkpoint: Checkpoint, direction: Direction) {
  if (!subject) {
    return { result: "denied" as ResultStatus, reason: "Barcode not registered" };
  }
  if (isHardware(subject) && subject.status === "restricted") {
    return { result: "restricted" as ResultStatus, reason: "Asset restricted" };
  }
  if (!isHardware(subject) && subject.type === "visitor") {
    if (subject.status === "expired") {
      return { result: "expired" as ResultStatus, reason: "Temporary barcode expired" };
    }
    if (subject.status !== "pre_approved") {
      return { result: "denied" as ResultStatus, reason: "Not pre-approved" };
    }
  }
  if (!zoneAllowed(subject, checkpoint)) {
    return { result: "restricted" as ResultStatus, reason: "Checkpoint zone not permitted" };
  }
  if (direction === "entry" && subject.inside) {
    return { result: "duplicate" as ResultStatus, reason: "Already inside" };
  }
  if (direction === "exit" && !subject.inside) {
    return { result: "duplicate" as ResultStatus, reason: "No active entry found" };
  }
  if (isHardware(subject) && direction === "exit" && checkpoint.id === "cp-warehouse") {
    return { result: "manual_review" as ResultStatus, reason: "Asset not expected out" };
  }
  return { result: "success" as ResultStatus, reason: "-" };
}

export function findSubject(barcode: string, people: Person[], hardware: HardwareAsset[]) {
  const normalized = barcode.trim().toLowerCase();
  return (
    people.find((person) => person.barcode.toLowerCase() === normalized) ??
    hardware.find((asset) => asset.barcode.toLowerCase() === normalized)
  );
}

export function evaluateScan({
  barcode,
  checkpoint,
  people,
  hardware,
  selectedHardwareIds,
  online,
  eventCount
}: ScanInput): ScanDecision {
  const subject = findSubject(barcode, people, hardware);
  const direction = directionFor(checkpoint, subject);
  const decision = statusFor(subject, checkpoint, direction);
  const carriedHardware = hardware.filter((asset) => selectedHardwareIds.includes(asset.id));
  const syncState: SyncState = online ? "synced" : "queued";
  const event: MovementEvent = {
    id: `EVT-${String(1000 + eventCount).padStart(6, "0")}`,
    time: currentTime(),
    checkpointId: checkpoint.id,
    checkpoint: checkpoint.name,
    direction,
    subjectId: subject?.id ?? "unknown",
    subjectName: subject?.name ?? "Unknown barcode",
    subjectType: subject ? (isHardware(subject) ? "hardware" : subject.type) : "visitor",
    barcode: barcode.trim(),
    result: decision.result,
    reason: decision.reason,
    scannerId: checkpoint.scannerId,
    syncState,
    hardwareIds: carriedHardware.map((asset) => asset.id)
  };

  return { event, subject, carriedHardware };
}

export function applyMovementState(
  event: MovementEvent,
  people: Person[],
  hardware: HardwareAsset[]
) {
  if (event.result !== "success") {
    return { people, hardware };
  }

  const inside = event.direction === "entry";
  return {
    people: people.map((person) =>
      person.id === event.subjectId ? { ...person, inside } : person
    ),
    hardware: hardware.map((asset) => {
      if (asset.id === event.subjectId || event.hardwareIds.includes(asset.id)) {
        return { ...asset, inside };
      }
      return asset;
    })
  };
}
