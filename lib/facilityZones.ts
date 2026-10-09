import type { Checkpoint } from "./types";

export const FACILITY_ZONES = [
  { id: "public", name: "Main Entrance", checkpointId: "cp-main" },
  { id: "secure", name: "Server Room", checkpointId: "server-room" },
] as const;

function zoneId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  if (["public", "main entrance"].includes(key)) return "public";
  if (["secure", "server room"].includes(key)) return "secure";
  return undefined;
}

/** Expand legacy labels without treating them as additional facility zones. */
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
  return FACILITY_ZONES.filter((zone) => zones.has(zone.id)).map((zone) => zone.id);
}

export function facilityZoneLabel(value: string): string {
  return FACILITY_ZONES.find((zone) => zone.id === zoneId(value))?.name ?? value;
}

export function formatFacilityZones(value: readonly string[]): string {
  return normalizeFacilityZones(value).map(facilityZoneLabel).join(" / ");
}

export function canonicalCheckpointId(value: string): string {
  return value === "main-gate" ? "cp-main" : value;
}

/** Collapse old checkpoint aliases in API responses and cached configuration. */
export function normalizeFacilityCheckpoints(value: unknown): Checkpoint[] {
  if (!Array.isArray(value)) return [];
  return FACILITY_ZONES.flatMap((zone) => {
    const checkpoint = value.find((item) => item?.id === zone.checkpointId)
      ?? value.find((item) => item && typeof item === "object" &&
        (canonicalCheckpointId(item.id) === zone.checkpointId || zoneId(item.zone) === zone.id || zoneId(item.name) === zone.id));
    return checkpoint ? [{ ...checkpoint, id: zone.checkpointId, name: zone.name, zone: zone.id } as Checkpoint] : [];
  });
}

export function normalizeSubjectZones<T extends { allowedZones?: unknown }>(subject: T): T {
  return { ...subject, allowedZones: normalizeFacilityZones(subject.allowedZones) };
}
