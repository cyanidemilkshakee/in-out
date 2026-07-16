import { AppChrome } from "../../components/AppChrome";
import { SecurityTerminal } from "../../components/terminal/SecurityTerminal";

export default function TerminalPage() {
  return (
    <AppChrome role="security">
      <SecurityTerminal />
    </AppChrome>
  );
}
