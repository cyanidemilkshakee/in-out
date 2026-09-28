import { UserManagement } from "../../../frontend/components/admin/UserManagement";
import { UserManagementLocked } from "../../../frontend/components/admin/UserManagementLocked";
import { auth } from "../../../auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { AppSession } from "../../../lib/keycloakSession";
import { USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";

export default async function ManageUsersPage() {
  const session = await auth() as AppSession | null;
  if (!session?.access_token || !session.roles.includes("admin")) redirect("/login");
  const cookieStore = await cookies();
  if (!session.stepUpExpiresAt || Date.now() / 1000 >= session.stepUpExpiresAt || cookieStore.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE)) return <UserManagementLocked />;
  return <UserManagement stepUpExpiresAt={session.stepUpExpiresAt} />;
}
