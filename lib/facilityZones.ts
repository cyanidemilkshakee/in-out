import type { Checkpoint } from "./types";

/** Bootstrap labels only; the zones API is authoritative for dynamic branches. */
export const FACILITY_ZONES = [
  { id: "a", name: "Zone A", checkpointId: "a-1" },
  { id: "b", name: "Zone B", checkpointId: "b-1" },
] as const;

function zoneId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ? key : undefined;
}

/** Normalize zone IDs without dropping valid dynamically-created branches. */
export function normalizeFacilityZones(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const zones = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (item.trim().toLowerCase() === "all zones") {
      FACILITY_ZONES.forEach((zone) => zones.add(zone.id));
    } else {
      const id = zoneId(item);
      if (id) zones.add(id);
    }
  }
  return [...zones].sort((left, right) => {
    const leftRank = FACILITY_ZONES.findIndex((zone) => zone.id === left);
    const rightRank = FACILITY_ZONES.findIndex((zone) => zone.id === right);
    if (leftRank >= 0 || rightRank >= 0) {
      if (leftRank < 0) return 1;
      if (rightRank < 0) return -1;
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

export function facilityZoneLabel(value: string): string {
  const id = zoneId(value);
  return FACILITY_ZONES.find((zone) => zone.id === id)?.name ?? (id ? `Zone ${id.toUpperCase()}` : value);
}

export function formatFacilityZones(value: readonly string[]): string {
  return normalizeFacilityZones(value).map(facilityZoneLabel).join(" / ");
}

export function canonicalCheckpointId(value: string): string {
  return value;
}

/** Validate checkpoint responses while retaining dynamically-created gates. */
export function normalizeFacilityCheckpoints(value: unknown): Checkpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Checkpoint[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Partial<Checkpoint>;
    const id = zoneId(record.id);
    const zone = zoneId(record.zoneId ?? record.zone);
    if (!id || !zone || typeof record.name !== "string" || !record.name.trim()) return [];
    const mode = ["auto", "manual", "entry", "exit"].includes(record.mode ?? "") ? record.mode! : "auto";
    return [{
      ...record,
      id,
      name: record.name.trim(),
      zone,
      zoneId: zone,
      number: typeof record.number === "number" ? record.number : undefined,
      gateType: record.gateType ?? "custom",
      gateLabel: record.gateLabel ?? "",
      required: record.required === true,
      active: record.active !== false,
      mode,
      online: typeof record.online === "boolean" ? record.online : true,
    } as Checkpoint];
  });
}

export function normalizeSubjectZones<T extends { allowedZones?: unknown }>(subject: T): T {
  return { ...subject, allowedZones: normalizeFacilityZones(subject.allowedZones) };
}
