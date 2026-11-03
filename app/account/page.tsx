import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";
import { AccountCenter } from "../../frontend/components/account/AccountCenter";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await auth() as AppSession | null;
  if (!session?.access_token || session.error) redirect("/login?from=%2Faccount");
  return <AccountCenter />;
}
