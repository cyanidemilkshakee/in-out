import { redirect } from "next/navigation";
import { apiSession } from "../../api/authSession";
import { hasMasterAdminAccess } from "../../../lib/applicationRoles";
import { MasterZoneAssignments } from "../../../frontend/components/admin/MasterZoneAssignments";

export const dynamic = "force-dynamic";

export default async function EmployeeZoneAccessPage() {
  const session = await apiSession();
  if (!session?.access_token || !hasMasterAdminAccess(session.roles)) redirect("/login");
  return <MasterZoneAssignments fixedKind="employee" />;
}
