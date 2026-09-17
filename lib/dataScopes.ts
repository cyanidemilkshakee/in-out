import type { DataScope } from "./types";

/** Backend bundle endpoint for each application data scope. */
export const DATA_SCOPE_ENDPOINTS: Partial<Record<DataScope, string>> = {
  dashboard: "/v1/dashboard",
  all: "/v1/dashboard",
  alerts: "/v1/alerts",
  permissions: "/v1/permissions",
  logs: "/v1/audit-events",
  registry: "/v1/registry/bundle",
  terminal: "/v1/terminal/bundle",
};

export const DATA_SCOPES = new Set<DataScope>([
  "dashboard",
  "logs",
  "registry",
  "permissions",
  "alerts",
  "profile",
  "terminal",
  "all",
]);
