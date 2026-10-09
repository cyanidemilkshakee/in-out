import { AppChrome } from "../../frontend/components/AppChrome";
import { SecurityTerminal } from "../../frontend/components/terminal/SecurityTerminal";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";

export default async function TerminalPage() {
  const session = await auth() as AppSession | null;
  return (
    <AppChrome role="security">
      <SecurityTerminal operatorSubject={session?.subject ?? ""} canManagePermissions={session?.roles.includes("admin") ?? false} />
    </AppChrome>
  );
}
