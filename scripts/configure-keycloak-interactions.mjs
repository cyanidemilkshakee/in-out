// Enable only a verified installed provider. Retiring the previous privileged
// reset client is a separate, explicit post-deployment step.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";
import { configureApplicationSignIn } from "./configure-keycloak-app-sign-in.mjs";
import { interactionProviderReady } from "./keycloak-interaction-access.mjs";

export async function retireNativePasswordClient(api, { apply = false, log = console.log } = {}) {
  const clients = await (await api("/clients?clientId=inout-password-updates")).json();
  if (!Array.isArray(clients)) throw new Error("Invalid native password client listing");
  const matches = clients.filter(client => client.clientId === "inout-password-updates");
  if (matches.length > 1 || matches.some(client => typeof client.id !== "string" || !client.id)) {
    throw new Error("Ambiguous native password client; inspect configuration before retirement");
  }
  if (!matches.length) return true;
  const path = `/clients/${encodeURIComponent(matches[0].id)}`;
  const client = await (await api(path)).json();
  if (client.enabled === false) return true;
  if (!apply) return false;
  await api(path, { method: "PUT", body: { enabled: false } });
  if ((await (await api(path)).json()).enabled !== false) throw new Error("Keycloak did not disable the previous native password client");
  log("Native password client disabled; its secret, policy history and unrelated realm data were preserved");
  return true;
}

export async function configureInteractions(api, { apply = false, providerReady, retireNative = false, log = console.log } = {}) {
  if (!await configureApplicationSignIn(api, { apply, providerReady, log })) return false;
  if (retireNative && !await retireNativePasswordClient(api, { apply, log })) return false;
  return true;
}

async function main() {
  const [mode, retirement, ...extra] = process.argv.slice(2);
  if (!["--check", "--apply"].includes(mode) || extra.length ||
      (retirement !== undefined && retirement !== "--retire-native-password-client")) {
    throw new Error("Usage: node scripts/configure-keycloak-interactions.mjs --check|--apply [--retire-native-password-client]");
  }
  const { api, adminBase } = await connectLocalKeycloak();
  if (!await configureInteractions(api, { apply: mode === "--apply", retireNative: retirement !== undefined,
    providerReady: client => interactionProviderReady(api, adminBase, client) })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
