import type { ReactNode } from "react";
import { apiSession } from "../api/authSession";
import { hasMasterAdminAccess } from "../../lib/applicationRoles";
import AdminLayoutClient from "./AdminLayoutClient";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await apiSession();
  return <AdminLayoutClient isMasterAdmin={hasMasterAdminAccess(session?.roles)}>{children}</AdminLayoutClient>;
}
