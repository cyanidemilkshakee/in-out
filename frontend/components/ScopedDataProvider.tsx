import type { ReactNode } from "react";
import type { DataScope } from "../../lib/types";
import { getSnapshot } from "../../backend/dataRepository";
import { AppProviders } from "./AppProviders";

export async function ScopedDataProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: DataScope;
}) {
  const initialData = await getSnapshot(scope);
  return (
    <AppProviders initialData={initialData} initialScope={scope}>
      {children}
    </AppProviders>
  );
}
