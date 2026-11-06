import { redirect } from "next/navigation";
import { apiSession } from "../api/authSession";
import { hasMasterAdminAccess } from "../../lib/applicationRoles";

export default async function AdminIndexPage() {
  const session = await apiSession();
  redirect(hasMasterAdminAccess(session?.roles) ? "/admin/users" : "/admin/dashboard");
}
