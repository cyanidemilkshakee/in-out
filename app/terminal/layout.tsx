import type { ReactNode } from "react";
import { ScopedDataProvider } from "../../frontend/components/ScopedDataProvider";

export const dynamic = "force-dynamic";

export default function TerminalDataLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <ScopedDataProvider scope="terminal">{children}</ScopedDataProvider>;
}
