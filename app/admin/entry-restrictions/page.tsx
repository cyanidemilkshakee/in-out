import { redirect } from "next/navigation";
import { apiSession } from "../../api/authSession";
import { hasMasterAdminAccess } from "../../../lib/applicationRoles";
import { MasterEntryRestrictions } from "../../../frontend/components/admin/MasterEntryRestrictions";

export const dynamic = "force-dynamic";

export default async function MasterEntryRestrictionsPage() {
  const session = await apiSession();
  if (!session?.access_token || !hasMasterAdminAccess(session.roles)) redirect("/login");
  return <MasterEntryRestrictions />;
}
