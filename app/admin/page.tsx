import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";
import { hasMasterAdminAccess } from "../../lib/applicationRoles";

export default async function AdminIndexPage() {
  const session = await auth() as AppSession | null;
  redirect(hasMasterAdminAccess(session?.roles) ? "/admin/users" : "/admin/dashboard");
}
