import type { ReactNode } from "react";
import type { AppDataSnapshot, DataScope } from "../../lib/types";
import { callPythonApi } from "../../app/api/pythonApi";
import {
  normalizeDashboardSnapshot,
  normalizeAlertsSnapshot,
  normalizePermissionsSnapshot,
  normalizeLogsSnapshot,
  normalizeRegistrySnapshot,
  normalizeTerminalSnapshot,
} from "../../lib/normalizeDashboard";
import { AppProviders } from "./AppProviders";

const SCOPE_ENDPOINT: Partial<Record<DataScope, string>> = {
  dashboard:   "/v1/dashboard",
  alerts:      "/v1/alerts",
  permissions: "/v1/permissions",
  logs:        "/v1/audit-events",
  registry:    "/v1/registry/bundle",
  terminal:    "/v1/terminal/bundle",
  // profile is handled by /api/profile — no initial data needed here
};

function normalizeForScope(scope: DataScope, raw: unknown): AppDataSnapshot {
  switch (scope) {
    case "dashboard":
    case "all":
      return normalizeDashboardSnapshot(raw);
    case "alerts":
      return normalizeAlertsSnapshot(raw);
    case "permissions":
      return normalizePermissionsSnapshot(raw);
    case "logs":
      return normalizeLogsSnapshot(raw);
    case "registry":
      return normalizeRegistrySnapshot(raw);
    case "terminal":
      return normalizeTerminalSnapshot(raw);
    default:
      return normalizeDashboardSnapshot(raw);
  }
}

export async function ScopedDataProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: DataScope;
}) {
  let initialData: AppDataSnapshot | undefined;
  const endpoint = SCOPE_ENDPOINT[scope];
  try {
    if (endpoint) {
      const raw = await callPythonApi(endpoint, "GET");
      initialData = normalizeForScope(scope, raw);
    }
    // profile scope has no bundle endpoint — let client fetch on mount
  } catch (error) {
    console.error("[scoped-data] initial load failed", {
      scope,
      endpoint: endpoint ?? null,
      error,
    });
    // If the backend is unreachable, let the client-side DataProvider fetch on mount
    initialData = undefined;
  }

  return (
    <AppProviders initialData={initialData} initialScope={scope}>
      {children}
    </AppProviders>
  );
}
