import type { ReactNode } from "react";
import { ScopedDataProvider } from "../../../components/ScopedDataProvider";

export const dynamic = "force-dynamic";

export default function PermissionsDataLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ScopedDataProvider scope="permissions">{children}</ScopedDataProvider>
  );
}
