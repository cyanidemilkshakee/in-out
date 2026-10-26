import type { Checkpoint } from "../lib/types";

async function request<T>(method: "GET" | "POST" | "DELETE", body?: unknown, checkpointId?: string): Promise<T> {
  const query = checkpointId ? `?checkpointId=${encodeURIComponent(checkpointId)}` : "";
  const response = await fetch(`/api/checkpoints${query}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || payload?.data === undefined) {
    throw new Error(payload?.error ?? "Checkpoint request failed.");
  }
  return payload.data;
}

export async function listCheckpoints(): Promise<Checkpoint[]> {
  const checkpoints = await request<Checkpoint[]>("GET");
  if (!Array.isArray(checkpoints)) throw new Error("Checkpoint service returned an invalid list.");
  return checkpoints;
}

export function createCheckpoint(input: { zoneId: string; name?: string; preset?: "back_gate" | "custom" }): Promise<Checkpoint> {
  return request<Checkpoint>("POST", input);
}

export function deleteCheckpoint(checkpointId: string): Promise<void> {
  return request<void>("DELETE", undefined, checkpointId);
}
