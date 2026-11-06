import { AppChrome } from "../../frontend/components/AppChrome";
import { SecurityTerminal } from "../../frontend/components/terminal/SecurityTerminal";
import { apiSession } from "../api/authSession";
import { hasAdminAccess } from "../../lib/applicationRoles";

export default async function TerminalPage() {
  const session = await apiSession();
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
