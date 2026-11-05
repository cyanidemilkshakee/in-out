// Configure the confidential client used by the application's own sign-in form.
// The separate Postman client and administrator-managed identity data stay intact.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";
import { interactionProviderReady } from "./keycloak-interaction-access.mjs";

const passwordActionProviders = ["setup", "change"];

export function requiredPasswordActionRedirectUris(client) {
  const standardCallbackUris = (Array.isArray(client?.redirectUris) ? client.redirectUris : [])
    .filter((uri) => typeof uri === "string" && uri.endsWith("/api/auth/callback/keycloak"));
  return [...new Set(standardCallbackUris.flatMap((uri) => passwordActionProviders.map((action) =>
    uri.replace(/\/api\/auth\/callback\/keycloak$/, `/api/auth/callback/keycloak-password-${action}`))))];
}

export function applicationSignInReady(client) {
  const appUrl = applicationBaseUrl();
  const passwordActionRedirectUris = requiredPasswordActionRedirectUris(client);
  return client?.enabled === true && client.publicClient === false && client.protocol === "openid-connect" &&
    client.standardFlowEnabled === true && client.directAccessGrantsEnabled === false &&
    client.implicitFlowEnabled === false && client.serviceAccountsEnabled === false &&
    client.rootUrl === appUrl && client.baseUrl === appUrl &&
    client.attributes?.["pkce.code.challenge.method"] === "S256" &&
    client.attributes?.["inout.app-interactions.enabled"] === "true" &&
    passwordActionRedirectUris.every((uri) => client.redirectUris.includes(uri)) &&
    client.attributes?.login_theme === "inout-app-errors";
}

function applicationBaseUrl() {
  const configured = process.env.AUTH_URL || process.env.INOUT_APP_URL ||
    `http://app.localhost:${process.env.APP_PORT || "1008"}`;
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUTH_URL must be an application origin without a path");
  }
  return url.origin;
}

export async function configureApplicationSignIn(api, { apply = false, log = console.log, providerReady } = {}) {
  const appUrl = applicationBaseUrl();
  const clients = await (await api("/clients?clientId=inout-frontend")).json();
  const matches = clients.filter((candidate) => candidate.clientId === "inout-frontend");
  if (matches.length !== 1 || !matches[0]?.id) throw new Error("Exactly one inout-frontend client is required");
  const client = await (await api(`/clients/${encodeURIComponent(matches[0].id)}`)).json();
  if (!client?.id || client.enabled !== true || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }
  // Never disable a working legacy sign-in until the installed extension has
  // authenticated the same confidential client and confirmed its protocol.
  if (typeof providerReady !== "function" || await providerReady(client) !== true) {
    if (apply) throw new Error("Verify the installed app-interaction provider before changing application sign-in");
    log("inout-frontend: app-interaction readiness must be verified before configuration");
    return false;
  }
  const passwordActionRedirectUris = requiredPasswordActionRedirectUris(client);
  const missingPasswordActionRedirectUris = passwordActionRedirectUris.filter((uri) => !(client.redirectUris || []).includes(uri));
  const redirectUris = [...(client.redirectUris || []), ...missingPasswordActionRedirectUris];

  const realm = await (await api("")).json();
  const realmNeedsRepair = realm.loginTheme === "inout";
  if (applicationSignInReady(client) && !realmNeedsRepair) {
    log("inout-frontend: app interactions configured; password grant disabled; standard code flow remains enabled");
    return true;
  }
  if (!apply) {
    log("inout-frontend: application sign-in needs repair (run with --apply)");
    return false;
  }

  // Merge attributes and exact callback URLs because Keycloak replaces those
  // maps/lists on update. Never send a secret, role, scope mapping or user.
  const path = `/clients/${encodeURIComponent(client.id)}`;
  if (!applicationSignInReady(client)) {
    await api(path, { method: "PUT", body: {
      rootUrl: appUrl,
      baseUrl: appUrl,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      ...(missingPasswordActionRedirectUris.length ? { redirectUris } : {}),
      attributes: { ...client.attributes, login_theme: "inout-app-errors", "pkce.code.challenge.method": "S256",
        "inout.app-interactions.enabled": "true" },
    } });
  }
  if (realmNeedsRepair) await api("", { method: "PUT", body: { loginTheme: "keycloak.v2" } });
  const updated = await (await api(path)).json();
  const updatedRealm = await (await api("")).json();
  if (!applicationSignInReady(updated) || updatedRealm.loginTheme === "inout") {
    throw new Error("Keycloak did not confirm the application sign-in and built-in login settings");
  }
  log("inout-frontend: app interactions configured; password grant disabled; standard code flow remains enabled");
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-app-sign-in.mjs --check|--apply");
  }
  const { api, adminBase } = await connectLocalKeycloak();
  if (!await configureApplicationSignIn(api, { apply: mode === "--apply",
    providerReady: client => interactionProviderReady(api, adminBase, client) })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
