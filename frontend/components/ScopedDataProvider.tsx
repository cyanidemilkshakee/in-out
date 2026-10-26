import type { ReactNode } from "react";
import type { AppDataSnapshot, DataScope } from "../../lib/types";
import { callPythonApi } from "../../app/api/pythonApi";
import { DATA_SCOPE_ENDPOINTS } from "../../lib/dataScopes";
import { normalizeDataScope } from "../../lib/normalizeDashboard";
import { AppProviders } from "./AppProviders";
import { loadAllAlerts } from "../../app/api/data/serverQueries";

export async function ScopedDataProvider({
  children,
  scope,
  clientManaged = false,
}: {
  children: ReactNode;
  scope: DataScope;
  clientManaged?: boolean;
}) {
  let initialData: AppDataSnapshot | undefined = clientManaged ? normalizeDataScope(scope, {}) : undefined;
  const endpoint = DATA_SCOPE_ENDPOINTS[scope];
  try {
    if (endpoint && !clientManaged) {
      const raw = scope === "alerts"
        ? await loadAllAlerts()
        : await callPythonApi(endpoint, "GET");
      initialData = normalizeDataScope(scope, raw);
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
    <AppProviders initialData={initialData} initialScope={scope} clientManaged={clientManaged}>
      {children}
    </AppProviders>
  );
}
