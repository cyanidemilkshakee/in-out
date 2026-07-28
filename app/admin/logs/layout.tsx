import type { ReactNode } from "react";
import { ScopedDataProvider } from "../../../components/ScopedDataProvider";

export const dynamic = "force-dynamic";

export default function LogsDataLayout({ children }: { children: ReactNode }) {
  return <ScopedDataProvider scope="logs">{children}</ScopedDataProvider>;
}
