"use client";

import type { ReactNode } from "react";
import { DataProvider } from "../context/DataContext";
import type { AppDataSnapshot, DataService } from "../services/dataService";
import {
  createMockDataSnapshot,
  MockDataService,
} from "../services/mockDataService";

const mockInitialData = createMockDataSnapshot();
const mockDataService = new MockDataService(mockInitialData);

export function AppProviders({
  children,
  service,
  initialData,
}: {
  children: ReactNode;
  service?: DataService;
  initialData?: AppDataSnapshot;
}) {
  const usingDefaultService = service === undefined;
  return (
    <DataProvider
      service={service ?? mockDataService}
      initialData={initialData ?? (usingDefaultService ? mockInitialData : undefined)}
    >
      {children}
    </DataProvider>
  );
}
