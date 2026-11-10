import type { OrganizationZone, ZoneAccessRequestTarget } from "../lib/types";

async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, zoneId?: string, view?: string, signal?: AbortSignal): Promise<T> {
  const query = view ? `?view=${encodeURIComponent(view)}` : "";
  const path = zoneId ? `/api/zones/${encodeURIComponent(zoneId)}` : `/api/zones${query}`;
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || payload?.data === undefined) {
    throw new Error(payload?.error ?? "Organization-zone request failed.");
  }
  return payload.data;
}

export async function listZones(): Promise<OrganizationZone[]> {
  const zones = await request<OrganizationZone[]>("GET");
  if (!Array.isArray(zones)) throw new Error("Zone service returned an invalid list.");
  return zones;
}

export async function listZoneAccessRequestTargets(signal?: AbortSignal): Promise<ZoneAccessRequestTarget[]> {
  const zones = await request<ZoneAccessRequestTarget[]>("GET", undefined, undefined, "access-request-targets", signal);
  if (!Array.isArray(zones)) throw new Error("Zone access request targets returned an invalid list.");
  return zones;
}

export function createZone(name: string): Promise<OrganizationZone> {
  return request<OrganizationZone>("POST", { name });
}

export function updateZoneName(zoneId: string, name: string): Promise<Pick<OrganizationZone, "id" | "name" | "active">> {
  return request<Pick<OrganizationZone, "id" | "name" | "active">>("PATCH", { name }, zoneId);
}

export function deleteZone(zoneId: string): Promise<void> {
  return request<void>("DELETE", undefined, zoneId);
}
