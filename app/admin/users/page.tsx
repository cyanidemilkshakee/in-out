import { UserManagement } from "../../../frontend/components/admin/UserManagement";
import { auth } from "../../../auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { AppSession } from "../../../lib/keycloakSession";
import { isActiveUserManagementStepUp, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";
import { userManagementWindowUnlocked } from "../../../lib/serverUserManagement";
import { hasAdminAccess } from "../../../lib/applicationRoles";

export default async function ManageUsersPage() {
  const session = await auth() as AppSession | null;
  if (!session?.access_token || !hasAdminAccess(session.roles)) redirect("/login");
  const cookieStore = await cookies();
  if (!isActiveUserManagementStepUp(session) || cookieStore.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) || !await userManagementWindowUnlocked(session)) {
    redirect("/login?from=%2Fadmin%2Fusers&stepUp=1");
  }
  return <UserManagement stepUpExpiresAt={session.stepUpExpiresAt!} stepUpDurationMinutes={session.stepUpDurationMinutes} />;
}
