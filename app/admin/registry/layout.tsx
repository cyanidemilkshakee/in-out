import type { ReactNode } from "react";
import { ScopedDataProvider } from "../../../components/ScopedDataProvider";

export const dynamic = "force-dynamic";

export default function RegistryDataLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <ScopedDataProvider scope="registry">{children}</ScopedDataProvider>;
}
