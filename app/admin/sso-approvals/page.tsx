import { redirect } from "next/navigation";
import { apiSession } from "../../api/authSession";
import { hasMasterAdminAccess } from "../../../lib/applicationRoles";
import { SsoApprovals } from "../../../frontend/components/admin/SsoApprovals";

export const dynamic = "force-dynamic";

export default async function SsoApprovalsPage() {
  const session = await apiSession();
  if (!session?.access_token) redirect("/login");
  if (!hasMasterAdminAccess(session.roles)) redirect("/admin/users");
  return <SsoApprovals />;
}
