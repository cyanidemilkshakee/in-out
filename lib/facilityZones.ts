import type { Checkpoint } from "./types";

export const FACILITY_ZONES = [
  { id: "public", name: "Main Entrance", checkpointId: "cp-main" },
  { id: "secure", name: "Server Room", checkpointId: "server-room" },
] as const;

export type FacilityCheckpoint = {
  id: string;
  name: string;
  zone: string;
};

export const FACILITY_CHECKPOINTS: FacilityCheckpoint[] = FACILITY_ZONES.map(({ id: zone, name, checkpointId: id }) => ({ id, name, zone }));

function zoneId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  if (["public", "main entrance"].includes(key)) return "public";
  if (["secure", "server room"].includes(key)) return "secure";
  return undefined;
}

export function normalizeFacilityZones(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const zones = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.trim().toLowerCase() === "all zones") {
      FACILITY_ZONES.forEach((zone) => zones.add(zone.id));
    } else {
      const id = zoneId(item);
      if (id) zones.add(id);
    }
  }
  return FACILITY_ZONES.filter((zone) => zones.has(zone.id)).map((zone) => zone.id);
}

export function facilityZoneLabel(value: string): string {
  const id = zoneId(value);
  return FACILITY_ZONES.find((zone) => zone.id === id)?.name ?? value;
}

export function formatFacilityZones(value: readonly string[]): string {
  const zones = normalizeFacilityZones(value);
  if (zones.length === FACILITY_ZONES.length) return "All zones";
  return zones.map(facilityZoneLabel).join(" · ");
}

export function canonicalCheckpointId(value: string): string {
  return value === "main-gate" ? "cp-main" : value;
}

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
