import type { DataScope } from "../../lib/types";

export function mergeById<T extends { id: string }>(current: T[], updates: T[]) {
  if (updates.length === 0) return current;
  const updateById = new Map(updates.map((item) => [item.id, item]));
  const merged = current.map((item) => updateById.get(item.id) ?? item);
  const existingIds = new Set(current.map((item) => item.id));
  return [...updates.filter((item) => !existingIds.has(item.id)), ...merged];
}

export function scopeForPath(pathname: string): DataScope {
  if (pathname.startsWith("/terminal")) return "terminal";
  if (pathname.startsWith("/admin/dashboard")) return "dashboard";
  if (pathname.startsWith("/admin/logs")) return "registry";
  if (pathname.startsWith("/admin/registry")) return "registry";
  if (pathname.startsWith("/admin/permissions")) return "permissions";
  if (pathname.startsWith("/admin/alerts")) return "alerts";
  if (pathname.startsWith("/admin/profile")) return "profile";
  return "all";
}
