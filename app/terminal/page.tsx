import { AppChrome } from "../../frontend/components/AppChrome";
import { SecurityTerminal } from "../../frontend/components/terminal/SecurityTerminal";

export default function TerminalPage() {
  return (
    <AppChrome role="security">
      <SecurityTerminal />
    </AppChrome>
  );
}
