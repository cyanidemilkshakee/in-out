import type { OrganizationZone } from "../lib/types";

async function request<T>(method: "GET" | "POST" | "DELETE", body?: unknown, zoneId?: string): Promise<T> {
  const query = zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : "";
  const response = await fetch(`/api/zones${query}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
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

export function createZone(name: string): Promise<OrganizationZone> {
  return request<OrganizationZone>("POST", { name });
}

export function deleteZone(zoneId: string): Promise<void> {
  return request<void>("DELETE", undefined, zoneId);
}
