import type {
  Checkpoint,
  DenialCode,
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
  scanType: "auto" | "manual";
};

function isHardware(subject: SubjectRecord): subject is HardwareAsset {
  return "category" in subject;
}

function currentDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function currentTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

export function denialCodeForReason(reason?: string): DenialCode {
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.includes("not registered")) return "barcode_not_registered";
  if (normalized.includes("temporary barcode expired")) return "expired_pass";
  if (normalized.includes("approval pending")) return "approval_pending";
  if (normalized.includes("not pre-approved")) return "not_preapproved";
  if (normalized.includes("assigned to")) return "custody_mismatch";
  if (normalized.includes("checkpoint zone")) return "zone_not_permitted";
  if (normalized.includes("already inside")) return "already_inside";
  if (normalized.includes("no active entry")) return "no_active_entry";
  if (normalized.includes("not expected out")) return "asset_not_expected_out";
  if (normalized.includes("asset restricted")) return "asset_restricted";
  if (normalized.includes("hardware") && normalized.includes("restricted")) {
    return "hardware_restricted";
  }
  if (normalized.includes("employee access restricted")) return "access_restricted";
  if (normalized.includes("employee access inactive")) return "access_inactive";
  return "manual_review";
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

function statusFor(
  subject: SubjectRecord | undefined,
  checkpoint: Checkpoint,
  direction: Direction,
  carriedHardware: HardwareAsset[]
) {
  if (!subject) {
    return { result: "denied" as ResultStatus, reason: "Barcode not registered" };
  }
  if (isHardware(subject) && subject.status === "restricted") {
    return { result: "denied" as ResultStatus, reason: "Asset restricted" };
  }
  if (!isHardware(subject) && subject.type === "employee") {
    if (subject.status === "restricted") {
      return { result: "denied" as ResultStatus, reason: "Employee access restricted" };
    }
    if (subject.status === "inactive") {
      return { result: "denied" as ResultStatus, reason: "Employee access inactive" };
    }
  }
  if (!isHardware(subject) && subject.type === "visitor") {
    if (subject.status === "expired") {
      return { result: "denied" as ResultStatus, reason: "Temporary barcode expired" };
    }
    if (subject.status !== "pre_approved") {
      return {
        result: "denied" as ResultStatus,
        reason:
          subject.status === "pending_approval"
            ? "Temporary visitor approval pending"
            : "Not pre-approved",
      };
    }
  }
  const restrictedHardware = carriedHardware.find((asset) => asset.status !== "active");
  if (restrictedHardware) {
    return {
      result: "denied" as ResultStatus,
      reason: `${restrictedHardware.name} is ${restrictedHardware.status}`,
    };
  }
  if (!isHardware(subject)) {
    const custodyMismatch = carriedHardware.find(
      (asset) => asset.assignedEmployeeId && asset.assignedEmployeeId !== subject.id
    );
    if (custodyMismatch) {
      return {
        result: "denied" as ResultStatus,
        reason: `Hardware assigned to ${custodyMismatch.assignedEmployeeName ?? "another employee"}; custody approval required`,
      };
    }
  }
  if (!zoneAllowed(subject, checkpoint)) {
    return { result: "denied" as ResultStatus, reason: "Checkpoint zone not permitted" };
  }
  if (direction === "entry" && subject.inside) {
    return { result: "denied" as ResultStatus, reason: "Already inside" };
  }
  if (direction === "exit" && !subject.inside) {
    return { result: "denied" as ResultStatus, reason: "No active entry found" };
  }
  if (isHardware(subject) && direction === "exit" && checkpoint.id === "cp-warehouse") {
    return { result: "denied" as ResultStatus, reason: "Asset not expected out" };
  }
  return { result: "approved" as ResultStatus, reason: "-" };
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
  eventCount,
  scanType
}: ScanInput): ScanDecision {
  const now = new Date();
  const subject = findSubject(barcode, people, hardware);
  const direction = directionFor(checkpoint, subject);
  const carriedHardware = hardware.filter((asset) => selectedHardwareIds.includes(asset.id));
  const decision = statusFor(subject, checkpoint, direction, carriedHardware);
  const syncState: SyncState = online ? "synced" : "queued";
  const event: MovementEvent = {
    id: `EVT-${String(1000 + eventCount).padStart(6, "0")}`,
    date: currentDate(now),
    time: currentTime(now),
    checkpointId: checkpoint.id,
    checkpoint: checkpoint.name,
    direction,
    subjectId: subject?.id ?? "unknown",
    subjectName: subject?.name ?? "Unknown barcode",
    subjectType: subject ? (isHardware(subject) ? "hardware" : subject.type) : "visitor",
    barcode: barcode.trim(),
    result: decision.result,
    reason: decision.reason,
    denialCode:
      decision.result === "denied" ? denialCodeForReason(decision.reason) : undefined,
    scanType,
    syncState,
    hardwareIds: carriedHardware.map((asset) => asset.id),
    createdAt: now.toISOString(),
  };

  return { event, subject, carriedHardware };
}

export function applyMovementState(
  event: MovementEvent,
  people: Person[],
  hardware: HardwareAsset[]
) {
  if (event.result !== "approved") {
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
