// Configure the confidential client used by the application's own sign-in form.
// The separate Postman client and administrator-managed identity data stay intact.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export function applicationSignInReady(client) {
  return client?.enabled === true && client.publicClient === false && client.protocol === "openid-connect" &&
    client.standardFlowEnabled === true && client.directAccessGrantsEnabled === true &&
    client.implicitFlowEnabled === false && client.serviceAccountsEnabled === false &&
    client.attributes?.["pkce.code.challenge.method"] === "S256" &&
    client.attributes?.login_theme !== "inout";
}

export async function configureApplicationSignIn(api, { apply = false, log = console.log } = {}) {
  const clients = await (await api("/clients?clientId=inout-frontend")).json();
  const matches = clients.filter((candidate) => candidate.clientId === "inout-frontend");
  if (matches.length !== 1 || !matches[0]?.id) throw new Error("Exactly one inout-frontend client is required");
  const client = await (await api(`/clients/${encodeURIComponent(matches[0].id)}`)).json();
  if (!client?.id || client.enabled !== true || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }

  const realm = await (await api("")).json();
  const realmNeedsRepair = realm.loginTheme === "inout";
  if (applicationSignInReady(client) && !realmNeedsRepair) {
    log("inout-frontend: application sign-in configured; built-in account setup remains available");
    return true;
  }
  if (!apply) {
    log("inout-frontend: application sign-in needs repair (run with --apply)");
    return false;
  }

  // Merge attributes because Keycloak replaces that map on update. Never send
  // a secret, redirect URI, role, scope mapping or user in this repair.
  const path = `/clients/${encodeURIComponent(client.id)}`;
  if (!applicationSignInReady(client)) {
    await api(path, { method: "PUT", body: {
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: true,
      serviceAccountsEnabled: false,
      attributes: { ...client.attributes, "pkce.code.challenge.method": "S256",
        ...(client.attributes?.login_theme === "inout" ? { login_theme: "keycloak.v2" } : {}) },
    } });
  }
  if (realmNeedsRepair) await api("", { method: "PUT", body: { loginTheme: "keycloak.v2" } });
  const updated = await (await api(path)).json();
  const updatedRealm = await (await api("")).json();
  if (!applicationSignInReady(updated) || updatedRealm.loginTheme === "inout") {
    throw new Error("Keycloak did not confirm the application sign-in and built-in login settings");
  }
  log("inout-frontend: application sign-in configured; built-in account setup remains available");
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-app-sign-in.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configureApplicationSignIn(api, { apply: mode === "--apply" })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
