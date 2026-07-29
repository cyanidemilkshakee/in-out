"use client";

import type { ReactNode } from "react";
import { DataProvider } from "../context/DataContext";
import type {
  AppDataSnapshot,
  DataScope,
  DataService,
} from "../../lib/types";
import { HttpDataService } from "../../services/httpDataService";

const backendDataService = new HttpDataService();

export function AppProviders({
  children,
  service,
  initialData,
  initialScope,
}: {
  children: ReactNode;
  service?: DataService;
  initialData?: AppDataSnapshot;
  initialScope?: DataScope;
}) {
  return (
    <DataProvider
      service={service ?? backendDataService}
      initialData={initialData}
      initialScope={initialScope}
    >
      {children}
    </DataProvider>
  );
}
