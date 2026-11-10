// Provision the server-only Keycloak authority used only to accept invitation links.
// The client secret is never printed or included in the browser application.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const INVITATION_CLIENT_ID = "inout-invitations";
const MANAGEMENT_ROLES = ["manage-users", "query-users", "view-users"];
const APPLICATION_ROLES = new Set(["admin", "zone-admin", "master-admin", "operator"]);
const DEFAULT_REALM_ROLES = new Set(["default-roles-inout", "offline_access", "uma_authorization"]);
const closedClient = {
  publicClient: false,
  protocol: "openid-connect",
  clientAuthenticatorType: "client-secret",
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
  fullScopeAllowed: false,
  redirectUris: [],
  webOrigins: [],
};

const sameSet = (left, right) => Array.isArray(left) && left.length === right.length &&
  new Set(left).size === right.length && right.every(value => left.includes(value));

async function document(api, path) {
  const response = await api(path);
  const value = await response.json();
  if (!value || typeof value !== "object") throw new Error("Invalid invitation-client configuration response");
  return value;
}

async function findClient(api) {
  const clients = await document(api, `/clients?clientId=${encodeURIComponent(INVITATION_CLIENT_ID)}`);
  if (!Array.isArray(clients)) throw new Error("Invalid Keycloak client listing");
  const matches = clients.filter(client => client.clientId === INVITATION_CLIENT_ID);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error("Ambiguous invitation service client");
  return matches[0] ?? null;
}

function clientReady(client) {
  return client?.enabled === true && Object.entries(closedClient).every(([key, value]) =>
    Array.isArray(value) ? sameSet(client[key] ?? [], value) : client[key] === value);
}

export async function configureInvitationClient(api, { apply = false, clientSecret, log = console.log } = {}) {
  if (typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(clientSecret)) {
    throw new Error("Set KEYCLOAK_INVITE_CLIENT_SECRET to an independent random URL-safe secret of at least 32 characters");
  }
  const needsRepair = () => {
    log("Invitations: server-only Keycloak client needs setup (run with --apply)");
    return false;
  };

  let client = await findClient(api);
  if (!client) {
    if (!apply) return needsRepair();
    await api("/clients", { method: "POST", body: {
      clientId: INVITATION_CLIENT_ID,
      name: "InOut invitation acceptance",
      description: "Server-only account activation for single-use invitations.",
      ...closedClient,
      enabled: false,
      secret: clientSecret,
    } });
    client = await findClient(api);
    if (!client) throw new Error("Keycloak did not create the invitation service client");
  }

  client = await document(api, `/clients/${encodeURIComponent(client.id)}`);
  if (client.protocol !== "openid-connect" || client.publicClient !== false) {
    throw new Error("The invitation service must be a confidential OIDC client");
  }
  const clientPath = `/clients/${encodeURIComponent(client.id)}`;
  const savedSecret = await document(api, `${clientPath}/client-secret`);
  if (savedSecret.value !== clientSecret) {
    throw new Error("KEYCLOAK_INVITE_CLIENT_SECRET does not match the existing client; preserve its secret or coordinate a separate rotation");
  }
  if (!clientReady(client)) {
    if (!apply) return needsRepair();
    // Keep the client disabled until its restricted service-account roles are verified.
    await api(clientPath, { method: "PUT", body: { ...closedClient, enabled: false } });
    client = await document(api, clientPath);
  }

  const serviceUser = await document(api, `${clientPath}/service-account-user`);
  if (typeof serviceUser.id !== "string" || !serviceUser.id ||
      serviceUser.username !== `service-account-${INVITATION_CLIENT_ID}`) {
    throw new Error("Keycloak did not confirm the invitation service account");
  }
  const management = await findClientById(api, "realm-management");
  if (!management) throw new Error("Keycloak's realm-management client is missing");

  const [realmMappings, managementMappings] = await Promise.all([
    document(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/realm`),
    document(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`),
  ]);
  if (!Array.isArray(realmMappings) || !Array.isArray(managementMappings) ||
      realmMappings.some(role => APPLICATION_ROLES.has(role.name) || !DEFAULT_REALM_ROLES.has(role.name))) {
    throw new Error("Invitation service account has unexpected realm role mappings; inspect it before provisioning");
  }
  const currentNames = new Set(managementMappings.map(role => role.name));
  const unexpected = [...currentNames].filter(name => !MANAGEMENT_ROLES.includes(name));
  if (unexpected.length) throw new Error("Invitation service account has unexpected realm-management roles; remove them before provisioning");

  const roleModels = [];
  for (const name of MANAGEMENT_ROLES) {
    const role = await document(api, `/clients/${encodeURIComponent(management.id)}/roles/${encodeURIComponent(name)}`);
    if (typeof role.id !== "string" || !role.id) throw new Error(`Keycloak is missing the ${name} role`);
    if (!currentNames.has(name)) roleModels.push(role);
  }
  if (roleModels.length && !apply) return needsRepair();
  if (roleModels.length) {
    await api(`/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`, {
      method: "POST", body: roleModels,
    });
  }
  const verifiedMappings = await document(api,
    `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`);
  if (!Array.isArray(verifiedMappings) || !sameSet(verifiedMappings.map(role => role.name), MANAGEMENT_ROLES)) {
    throw new Error("Keycloak did not confirm the invitation service account's restricted roles");
  }

  if (!clientReady(client)) {
    if (!apply) return needsRepair();
    await api(clientPath, { method: "PUT", body: { enabled: true } });
    client = await document(api, clientPath);
  }
  if (!clientReady(client)) throw new Error("Keycloak did not confirm the server-only invitation client configuration");
  log("Invitations: server-only service account configured with user-management access");
  return true;
}

async function findClientById(api, clientId) {
  const clients = await document(api, `/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!Array.isArray(clients)) throw new Error("Invalid Keycloak client listing");
  const matches = clients.filter(client => client.clientId === clientId);
  if (matches.length > 1) throw new Error(`Ambiguous ${clientId} client listing`);
  return matches[0] ?? null;
}

async function main() {
  const mode = process.argv[2];
  if (!["--apply", "--check"].includes(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-invitations.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configureInvitationClient(api, {
    apply: mode === "--apply",
    clientSecret: process.env.KEYCLOAK_INVITE_CLIENT_SECRET,
  })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
