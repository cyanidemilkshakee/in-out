import type { Alert, HardwareAsset, MovementEvent, Person, PermissionRequest } from "../../lib/types";
import type { DataState } from "./dataTypes";
import { mergeById } from "./dataHelpers";

export type PresenceUpdate = {
  subject_id?: string;
  state?: "inside" | "outside";
  movement?: MovementEvent;
  people?: Person[];
  hardwareAssets?: HardwareAsset[];
  request?: PermissionRequest;
  alerts?: Alert[];
};

export function parsePresenceUpdate(raw: string): PresenceUpdate | null {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["people", "hardwareAssets"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) ||
        value[key].some((item: unknown) => !item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string"))) return null;
  }
  if (value.alerts !== undefined && (!Array.isArray(value.alerts) ||
      value.alerts.some((item: unknown) => !item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string"))) return null;
  if (value.movement && (typeof value.movement.id !== "string" ||
      !["entry", "exit"].includes(value.movement.direction) || !["approved", "denied"].includes(value.movement.result))) return null;
  if (value.request && typeof value.request.id !== "string") return null;
  return value as PresenceUpdate;
}

export function applyPresenceUpdate(current: DataState, update: PresenceUpdate): DataState {
  const permissionRequests = update.request ? mergeById(current.permissionRequests, [update.request]) : current.permissionRequests;
  const alerts = update.alerts ? mergeById(current.alerts, update.alerts) : current.alerts;
  const updatePresence = <T extends Person | HardwareAsset>(items: T[]): T[] => items.map(item =>
    update.subject_id === item.id && (update.state === "inside" || update.state === "outside")
      ? { ...item, inside: update.state === "inside" } : item);
  const people = mergeById(updatePresence(current.people), update.people ?? []);
  const hardwareAssets = mergeById(updatePresence(current.hardwareAssets), update.hardwareAssets ?? []);
  const movement = update.movement;
  let occupancyDelta = 0;
  if (movement?.result === "approved" && movement.subjectType !== "hardware") {
    const before = current.people.find(person => person.id === movement.subjectId);
    const after = people.find(person => person.id === movement.subjectId);
    occupancyDelta = before && after ? Number(after.inside) - Number(before.inside) : movement.direction === "entry" ? 1 : -1;
  } else if (!movement) {
    for (const person of current.people) {
      const after = people.find(item => item.id === person.id);
      if (after) occupancyDelta += Number(after.inside) - Number(person.inside);
    }
  }
  const previousMovement = movement && current.movements.find(item => item.id === movement.id);
  const movementTotals = (item: MovementEvent) => {
    const approved = item.result === "approved";
    const restricted = [
      "asset_restricted",
      "access_restricted",
      "hardware_restricted",
      "zone_not_permitted",
    ].includes(item.denialCode ?? "");
    const expired = item.denialCode === "expired_pass";
    return {
      totalScans: 1,
      totalApproved: Number(approved),
      totalDenied: Number(!approved),
      totalEntries: Number(approved && item.direction === "entry"),
      totalExits: Number(approved && item.direction === "exit"),
      totalAutomatic: Number(item.scanType === "auto"),
      totalManual: Number(item.scanType !== "auto"),
      totalRestricted: Number(!approved && restricted),
      totalExpired: Number(!approved && expired),
      totalOtherDenied: Number(!approved && !restricted && !expired),
    };
  };
  const analyticsKeys = [
    "totalScans", "totalApproved", "totalDenied", "totalEntries", "totalExits",
    "totalAutomatic", "totalManual", "totalRestricted", "totalExpired", "totalOtherDenied",
  ] as const;
  let analytics = current.scanAnalytics;
  if (movement) {
    const before = previousMovement ? movementTotals(previousMovement) : null;
    const after = movementTotals(movement);
    analytics = { ...current.scanAnalytics };
    for (const key of analyticsKeys) {
      analytics[key] = current.scanAnalytics[key] - (before?.[key] ?? 0) + after[key];
    }
  }
  return {
    ...current, people, hardwareAssets, permissionRequests, alerts,
    movements: movement ? mergeById(current.movements, [movement]).slice(0, 100) : current.movements,
    scanAnalytics: { ...analytics, activeInside: Math.max(0, current.scanAnalytics.activeInside + occupancyDelta) },
  };
}
