// Add the exact browser callback/origin values for the configured public app URL.
// Existing callbacks and Keycloak client settings are preserved.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

function applicationUrl() {
  const configured = process.env.AUTH_URL || process.env.INOUT_APP_URL ||
    `http://app.localhost:${process.env.APP_PORT || "1008"}`;
  let url;
  try { url = new URL(configured); } catch { throw new Error("AUTH_URL must be a complete application origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUTH_URL must be an HTTP(S) application origin without a path.");
  }
  return url.origin;
}

export function requiredApplicationClientUrls(origin) {
  const base = origin.replace(/\/$/, "");
  return {
    redirectUris: [
      `${base}/api/auth/callback/keycloak`,
      `${base}/api/auth/callback/keycloak-password-setup`,
      `${base}/api/auth/callback/keycloak-password-change`,
    ],
    webOrigins: [base],
    postLogoutRedirectUris: [`${base}/login`, `${base}/logout/complete`],
  };
}

export async function configurePublicApplicationUrls(api, { origin = applicationUrl(), apply = false, log = console.log } = {}) {
  const matches = await (await api("/clients?clientId=inout-frontend")).json();
  const clients = matches.filter((client) => client.clientId === "inout-frontend");
  if (clients.length !== 1 || !clients[0]?.id) throw new Error("Exactly one inout-frontend client is required");
  const path = `/clients/${encodeURIComponent(clients[0].id)}`;
  const client = await (await api(path)).json();
  if (!client?.enabled || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }

  const required = requiredApplicationClientUrls(origin);
  const redirectUris = [...new Set([...(client.redirectUris || []), ...required.redirectUris])];
  const webOrigins = [...new Set([...(client.webOrigins || []), ...required.webOrigins])];
  const currentLogoutUris = (client.attributes?.["post.logout.redirect.uris"] || "")
    .split("##").map((uri) => uri.trim()).filter(Boolean);
  const logoutUris = [...new Set([...currentLogoutUris, ...required.postLogoutRedirectUris])];
  const attributes = {
    ...client.attributes,
    "post.logout.redirect.uris": logoutUris.join("##"),
  };
  const changed = redirectUris.length !== (client.redirectUris || []).length ||
    webOrigins.length !== (client.webOrigins || []).length ||
    attributes["post.logout.redirect.uris"] !== client.attributes?.["post.logout.redirect.uris"];

  if (!changed) {
    log(`inout-frontend: public callbacks and origins are configured for ${origin}`);
    return true;
  }
  if (!apply) {
    log(`inout-frontend: public callback/origin settings need updating for ${origin} (run with --apply)`);
    return false;
  }

  await api(path, { method: "PUT", body: { redirectUris, webOrigins, attributes } });
  const updated = await (await api(path)).json();
  const actual = requiredApplicationClientUrls(origin);
  const actualLogoutUris = (updated.attributes?.["post.logout.redirect.uris"] || "").split("##");
  if (!actual.redirectUris.every((uri) => updated.redirectUris?.includes(uri)) ||
      !actual.webOrigins.every((uri) => updated.webOrigins?.includes(uri)) ||
      !actual.postLogoutRedirectUris.every((uri) => actualLogoutUris.includes(uri))) {
    throw new Error("Keycloak did not confirm all public application URLs");
  }
  log(`inout-frontend: added exact public callback/origin URLs for ${origin}; existing values were preserved`);
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-public-urls.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configurePublicApplicationUrls(api, { apply: mode === "--apply" })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
