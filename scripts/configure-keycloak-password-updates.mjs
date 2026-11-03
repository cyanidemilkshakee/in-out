// Provision only the native Admin REST authority used by app password forms.
// No credentials are printed; existing secrets are checked, never rotated.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const PASSWORD_UPDATE_CLIENT_ID = "inout-password-updates";
const POLICY_NAME = "inout-password-updates-service";
const PERMISSION_NAME = "inout-password-updates-users";
const DESCRIPTION = "Managed by IN / OUT password-update provisioning.";
const APPLICATION_ROLES = new Set(["admin", "zone-admin", "master-admin", "operator"]);

const sameSet = (left, right) => Array.isArray(left) && left.length === right.length &&
  new Set(left).size === right.length && right.every(value => left.includes(value));
const closedClient = {
  publicClient: false, protocol: "openid-connect", clientAuthenticatorType: "client-secret",
  standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true, fullScopeAllowed: false, redirectUris: [], webOrigins: [],
};

export function passwordUpdateClientReady(client) {
  return client?.enabled === true && Object.entries(closedClient).every(([key, value]) =>
    Array.isArray(value) ? sameSet(client[key] ?? [], value) : client[key] === value);
}

async function document(api, path, options) {
  const value = await (await api(path, options)).json();
  if (!value || typeof value !== "object") throw new Error("Invalid password-update configuration response");
  return value;
}

async function exactClient(api, clientId) {
  const clients = await document(api, `/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!Array.isArray(clients)) throw new Error("Invalid identity client listing");
  const matches = clients.filter(client => client.clientId === clientId);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error("Ambiguous password-update identity client");
  return matches[0] ?? null;
}

async function assertServiceRoles(api, serviceUser, management) {
  const realmRoles = await document(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/realm/composite`);
  const clientRoles = await document(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}/composite`);
  if (!Array.isArray(realmRoles) || !Array.isArray(clientRoles) || clientRoles.length ||
      realmRoles.some(role => APPLICATION_ROLES.has(role.name))) {
    throw new Error("Password-update service account has unexpected application or administration roles; remove them before provisioning");
  }
}

async function namedDocument(api, base, name) {
  const documents = await document(api, `${base}?name=${encodeURIComponent(name)}`);
  if (!Array.isArray(documents)) throw new Error("Invalid password-update permission listing");
  const matches = documents.filter(value => value.name === name);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error("Ambiguous password-update permission configuration");
  return matches[0] ?? null;
}

function policyUsers(policy) {
  if (Array.isArray(policy.users)) return policy.users;
  try { return JSON.parse(policy.config?.users ?? "null"); }
  catch { return null; }
}

async function permissionDocument(api, base, id) {
  const path = `${base}/${encodeURIComponent(id)}`;
  // Typed permission representations omit their associations by default.
  // Read the native association endpoints rather than trusting POST echoes.
  const [permission, resources, policies] = await Promise.all([
    document(api, `${path}?fields=*`), document(api, `${path}/resources`),
    document(api, `${path}/associatedPolicies`),
  ]);
  if (!Array.isArray(resources) || !Array.isArray(policies)) throw new Error("Invalid password-update permission associations");
  return { ...permission, resources, policies: policies.map(policy => policy.id) };
}

export async function configurePasswordUpdates(api, { apply = false, clientSecret, log = console.log } = {}) {
  if (typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(clientSecret)) {
    throw new Error("Set KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET to an independent random URL-safe secret of at least 32 characters");
  }
  const needsRepair = () => { log("Password updates: server-only native API configuration needs repair (run with --apply)"); return false; };
  let client = await exactClient(api, PASSWORD_UPDATE_CLIENT_ID);
  if (!client) {
    if (!apply) return needsRepair();
    await api("/clients", { method: "POST", body: {
      clientId: PASSWORD_UPDATE_CLIENT_ID, name: "InOut password updates", description: DESCRIPTION,
      ...closedClient, enabled: false, secret: clientSecret,
    } });
    client = await exactClient(api, PASSWORD_UPDATE_CLIENT_ID);
    if (!client) throw new Error("Keycloak did not create the password-update service client");
  }
  client = await document(api, `/clients/${encodeURIComponent(client.id)}`);
  if (client.protocol !== "openid-connect" || client.publicClient !== false) {
    throw new Error("Password updates require the dedicated confidential OIDC service client");
  }
  const path = `/clients/${encodeURIComponent(client.id)}`;
  const savedSecret = await document(api, `${path}/client-secret`);
  if (savedSecret.value !== clientSecret) {
    throw new Error("KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET does not match the existing client; preserve its secret or coordinate a separate rotation");
  }
  if (!passwordUpdateClientReady(client)) {
    if (!apply) return needsRepair();
    // Keep a repaired/new service disabled until its restricted authority has
    // been installed and checked. No browser/direct grant is ever enabled.
    await api(path, { method: "PUT", body: { ...closedClient, enabled: false } });
    client = await document(api, path);
  }
  const serviceUser = await document(api, `${path}/service-account-user`);
  // The dedicated client endpoint pins this identity. Keycloak's native user
  // representation does not include serviceAccountClientId on this endpoint.
  if (typeof serviceUser.id !== "string" || !serviceUser.id || serviceUser.username !== `service-account-${PASSWORD_UPDATE_CLIENT_ID}`) {
    throw new Error("Keycloak did not confirm the dedicated password-update service account");
  }
  const management = await exactClient(api, "realm-management");
  if (!management) throw new Error("Missing built-in realm-management client");
  await assertServiceRoles(api, serviceUser, management);

  let realm = await document(api, "");
  if (realm.adminPermissionsEnabled !== true) {
    if (!apply) return needsRepair();
    await api("", { method: "PUT", body: { adminPermissionsEnabled: true } });
    realm = await document(api, "");
    if (realm.adminPermissionsEnabled !== true) throw new Error("Keycloak did not enable fine-grained administration permissions");
  }
  const permissionsClient = await exactClient(api, "admin-permissions");
  if (!permissionsClient) throw new Error("Keycloak did not create the fine-grained administration client");
  const authorization = `/clients/${encodeURIComponent(permissionsClient.id)}/authz/resource-server`;
  const desiredPolicy = { name: POLICY_NAME, description: DESCRIPTION, type: "user", logic: "POSITIVE", users: [serviceUser.id] };
  let listedPolicy = await namedDocument(api, `${authorization}/policy`, POLICY_NAME);
  let policy = listedPolicy ? await document(api, `${authorization}/policy/user/${encodeURIComponent(listedPolicy.id)}`) : null;
  if (policy && (policy.type !== "user" || policy.description !== DESCRIPTION)) {
    throw new Error("Existing password-update policy is not owned by this configuration; inspect it before repair");
  }
  if (!policy || policy.logic !== "POSITIVE" || !sameSet(policyUsers(policy), desiredPolicy.users)) {
    if (!apply) return needsRepair();
    await api(`${authorization}/policy/user${policy ? `/${encodeURIComponent(policy.id)}` : ""}`, {
      method: policy ? "PUT" : "POST", body: { ...desiredPolicy, ...(policy ? { id: policy.id } : {}) },
    });
    listedPolicy = await namedDocument(api, `${authorization}/policy`, POLICY_NAME);
    if (!listedPolicy) throw new Error("Keycloak did not persist the password-update policy");
    policy = await document(api, `${authorization}/policy/user/${encodeURIComponent(listedPolicy.id)}`);
  }
  if (policy.type !== "user" || policy.logic !== "POSITIVE" || !sameSet(policyUsers(policy), desiredPolicy.users)) {
    throw new Error("Keycloak did not confirm the restricted service-account policy");
  }

  const desiredPermission = { name: PERMISSION_NAME, description: DESCRIPTION, type: "scope", logic: "POSITIVE",
    decisionStrategy: "UNANIMOUS", resourceType: "Users", resources: [], scopes: ["view", "reset-password"], policies: [policy.id] };
  let listedPermission = await namedDocument(api, `${authorization}/permission/scope`, PERMISSION_NAME);
  let permission = listedPermission ? await permissionDocument(api, `${authorization}/permission/scope`, listedPermission.id) : null;
  if (permission && (permission.type !== "scope" || permission.description !== DESCRIPTION)) {
    throw new Error("Existing password-update permission is not owned by this configuration; inspect it before repair");
  }
  // Exported permission representations may contain scope IDs instead of
  // names. Resolve the server's scope catalog before comparing authority.
  const scopes = await document(api, `${authorization}/scope`);
  if (!Array.isArray(scopes)) throw new Error("Invalid administration scope catalog");
  const names = values => Array.isArray(values) ? values.map(value => scopes.find(scope => scope.id === value)?.name ?? value) : null;
  const permissionReady = value => value?.type === "scope" && value.description === DESCRIPTION && value.resourceType === "Users" &&
    value.logic === "POSITIVE" && value.decisionStrategy === "UNANIMOUS" &&
    // FGAP stores an internal Users resource for an all-users permission.
    // Specific user IDs or any additional resources must not pass this check.
    Array.isArray(value.resources) && value.resources.length === 1 && value.resources[0].name === "Users" &&
    sameSet(names(value.scopes), desiredPermission.scopes) && sameSet(value.policies, [policy.id]);
  if (!permissionReady(permission)) {
    if (!apply) return needsRepair();
    await api(`${authorization}/permission/scope${permission ? `/${encodeURIComponent(permission.id)}` : ""}`, {
      method: permission ? "PUT" : "POST", body: { ...desiredPermission, ...(permission ? { id: permission.id } : {}) },
    });
    listedPermission = await namedDocument(api, `${authorization}/permission/scope`, PERMISSION_NAME);
    if (!listedPermission) throw new Error("Keycloak did not persist the password-update permission");
    permission = await permissionDocument(api, `${authorization}/permission/scope`, listedPermission.id);
  }
  if (!permissionReady(permission)) throw new Error("Keycloak did not confirm view/reset-password-only authority");
  await assertServiceRoles(api, serviceUser, management);
  if (!passwordUpdateClientReady(client)) {
    if (!apply) return needsRepair();
    await api(path, { method: "PUT", body: { enabled: true } });
    client = await document(api, path);
    if (!passwordUpdateClientReady(client)) throw new Error("Keycloak did not confirm the server-only client configuration");
  }
  log("Password updates: native API configured for the dedicated service account (view and reset-password only)");
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!["--check", "--apply"].includes(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-password-updates.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configurePasswordUpdates(api, {
    apply: mode === "--apply", clientSecret: process.env.KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET,
  })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
