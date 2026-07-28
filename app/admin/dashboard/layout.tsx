import type { ReactNode } from "react";
import { ScopedDataProvider } from "../../../components/ScopedDataProvider";

export const dynamic = "force-dynamic";

export default function DashboardDataLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <ScopedDataProvider scope="dashboard">{children}</ScopedDataProvider>;
}
