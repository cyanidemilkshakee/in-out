import { AppChrome } from "../../frontend/components/AppChrome";
import { SecurityTerminal } from "../../frontend/components/terminal/SecurityTerminal";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";
import { hasAdminAccess } from "../../lib/applicationRoles";

export default async function TerminalPage() {
  const session = await auth() as AppSession | null;
  return (
    <AppChrome role="security">
      <SecurityTerminal
        operatorSubject={session?.subject ?? ""}
        accountName={session?.user?.name ?? ""}
        accountEmail={session?.user?.email ?? ""}
        accountRole={hasAdminAccess(session?.roles) ? "Admin" : "Operator"}
        canManagePermissions={hasAdminAccess(session?.roles)}
      />
    </AppChrome>
  );
}
