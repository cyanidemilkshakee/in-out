import type { ReactNode } from "react";
import type { AppDataSnapshot, DataScope } from "../../lib/types";
import { callPythonApi } from "../../app/api/pythonApi";
import { DATA_SCOPE_ENDPOINTS } from "../../lib/dataScopes";
import { normalizeDataScope } from "../../lib/normalizeDashboard";
import { AppProviders } from "./AppProviders";

export async function ScopedDataProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: DataScope;
}) {
  let initialData: AppDataSnapshot | undefined;
  const endpoint = DATA_SCOPE_ENDPOINTS[scope];
  try {
    if (endpoint) {
      const raw = await callPythonApi(endpoint, "GET");
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
    <AppProviders initialData={initialData} initialScope={scope}>
      {children}
    </AppProviders>
  );
}
