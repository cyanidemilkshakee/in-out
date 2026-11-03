import type { ReactNode } from "react";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";
import { hasMasterAdminAccess } from "../../lib/applicationRoles";
import AdminLayoutClient from "./AdminLayoutClient";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth() as AppSession | null;
  return <AdminLayoutClient isMasterAdmin={hasMasterAdminAccess(session?.roles)}>{children}</AdminLayoutClient>;
}
