import type { AppDataSnapshot, DataScope, MovementEvent, Person } from "../../lib/types";

export function mergeById<T extends { id: string }>(current: T[], updates: T[]) {
  if (updates.length === 0) return current;
  const updateById = new Map(updates.map((item) => [item.id, item]));
  const merged = current.map((item) => updateById.get(item.id) ?? item);
  const existingIds = new Set(current.map((item) => item.id));
  return [...updates.filter((item) => !existingIds.has(item.id)), ...merged];
}

export function addMovementToAnalytics(
  analytics: AppDataSnapshot["scanAnalytics"],
  movement: MovementEvent,
  updatedPeople: Person[]
) {
  const approved = movement.result === "approved";
  const restricted = [
    "asset_restricted",
    "access_restricted",
    "hardware_restricted",
    "zone_not_permitted",
  ].includes(movement.denialCode ?? "");
  const expired = movement.denialCode === "expired_pass";
  const personPresenceDelta =
    approved && updatedPeople.length > 0
      ? movement.direction === "entry"
        ? 1
        : -1
      : 0;

  return {
    ...analytics,
    totalScans: analytics.totalScans + 1,
    totalApproved: analytics.totalApproved + Number(approved),
    totalDenied: analytics.totalDenied + Number(!approved),
    totalEntries: analytics.totalEntries + Number(approved && movement.direction === "entry"),
    totalExits: analytics.totalExits + Number(approved && movement.direction === "exit"),
    totalAutomatic: analytics.totalAutomatic + Number(movement.scanType === "auto"),
    totalManual: analytics.totalManual + Number(movement.scanType !== "auto"),
    totalRestricted: analytics.totalRestricted + Number(!approved && restricted),
    totalExpired: analytics.totalExpired + Number(!approved && expired),
    totalOtherDenied: analytics.totalOtherDenied + Number(!approved && !restricted && !expired),
    activeInside: Math.max(0, analytics.activeInside + personPresenceDelta),
  };
}

export function scopeForPath(pathname: string): DataScope {
  if (pathname.startsWith("/terminal")) return "terminal";
  if (pathname.startsWith("/admin/dashboard")) return "dashboard";
  if (pathname.startsWith("/admin/logs")) return "logs";
  if (pathname.startsWith("/admin/registry")) return "registry";
  if (pathname.startsWith("/admin/permissions")) return "permissions";
  if (pathname.startsWith("/admin/alerts")) return "alerts";
  if (pathname.startsWith("/admin/profile")) return "profile";
  return "all";
}
