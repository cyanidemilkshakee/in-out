import { UserManagement } from "../../../frontend/components/admin/UserManagement";
import { apiSession } from "../../api/authSession";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isActiveUserManagementStepUp, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";
import { userManagementWindowUnlocked } from "../../../lib/serverUserManagement";
import { hasAdminAccess, hasMasterAdminAccess } from "../../../lib/applicationRoles";

export default async function ManageUsersPage() {
  const session = await apiSession();
  if (!session?.access_token || !hasAdminAccess(session.roles)) redirect("/login");
  const isMasterAdmin = hasMasterAdminAccess(session.roles);
  if (!isMasterAdmin) {
    const cookieStore = await cookies();
    if (!isActiveUserManagementStepUp(session) || cookieStore.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) || !await userManagementWindowUnlocked(session)) {
      redirect("/login?from=%2Fadmin%2Fusers&stepUp=1");
    }
  }
  return <UserManagement isMasterAdmin={isMasterAdmin} stepUpExpiresAt={isMasterAdmin ? undefined : session.stepUpExpiresAt} stepUpDurationMinutes={session.stepUpDurationMinutes} />;
}
