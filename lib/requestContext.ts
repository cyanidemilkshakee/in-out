import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Correlation is diagnostic only. Never use a caller's ID as authority or identity.
const requestIds = new AsyncLocalStorage<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizedRequestId(value: string | null | undefined): string {
  return value && UUID.test(value) ? value.toLowerCase() : randomUUID();
}

export function currentRequestId(): string | undefined {
  return requestIds.getStore();
}

export function withRequestContext<T>(incomingId: string | null | undefined, work: () => T): T {
  return requestIds.run(normalizedRequestId(incomingId), work);
}

/** Logs identify endpoint families without retaining query values or record IDs. */
export function upstreamRoute(path: string): string {
  const segments = path.split("?", 1)[0].split("/");
  if (segments[1] !== "v1") return "upstream";
  const families = new Set([
    "registry", "alerts", "alert-warnings", "alert-rule-assignments", "permissions",
    "permission-requests", "terminal", "movements", "presence", "dashboard", "audit",
    "checkpoints", "keycloak", "user-management", "admin", "exports",
  ]);
  return families.has(segments[2]) ? `/v1/${segments[2]}` : "/v1/other";
}
