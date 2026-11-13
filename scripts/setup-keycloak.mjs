// One self-contained entry point for preparing the InOut Keycloak realm.
// It connects once with the bootstrap administrator, runs each operation in
// this file, and stops immediately if an apply or verification fails.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF_SERVICE_ROLES = ["manage-account", "view-profile"];
const APPLICATION_ROLES = ["zone-admin", "operator"];
const DELEGATED_ADMIN_ROLES = ["manage-users", "query-users", "view-users", "view-realm"];
const PASSWORD_ACTION_PROVIDERS = ["setup", "change"];
export const INTERACTION_PROTOCOL = "inout-app-interactions-v1";
export const INTERACTION_EXTENSION_VERSION = 1;
export const INTERACTION_KEYCLOAK_VERSION = "26.8.2";
export const APP_PASSWORD_POLICY = "length(12) and notUsername(undefined) and notEmail(undefined) and passwordBlacklist(inout-common-passwords.txt)";

let environmentLoaded = false;
function loadProjectEnvironment() {
  if (environmentLoaded) return;
  environmentLoaded = true;
  try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function configuredKeycloakOrigins() {
  loadProjectEnvironment();
  const publicPort = process.env.KEYCLOAK_PORT || "1005";
  const adminPort = process.env.KEYCLOAK_ADMIN_PORT || "1009";
  for (const [name, value] of [["KEYCLOAK_PORT", publicPort], ["KEYCLOAK_ADMIN_PORT", adminPort]]) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid local ${name}`);
  }
  const configured = [
    process.env.KEYCLOAK_PUBLIC_URL?.trim() || `http://auth.localhost:${publicPort}`,
    process.env.KEYCLOAK_ADMIN_ORIGIN?.trim() || process.env.KEYCLOAK_ADMIN_CONSOLE_URL?.trim() || `http://auth.localhost:${adminPort}`,
  ];
  return new Set(configured.map((value) => {
    let target;
    try { target = new URL(value); } catch { throw new Error("Keycloak maintenance credentials must use the configured auth.localhost origin or an explicitly configured HTTPS origin"); }
    const localConsolePath = target.hostname === "auth.localhost" && target.pathname === "/admin/master/console/";
    if (!( ["http:", "https:"].includes(target.protocol) && target.hostname &&
        !target.username && !target.password && (["", "/"].includes(target.pathname) || localConsolePath) && !target.search && !target.hash &&
        (target.protocol === "https:" || target.hostname === "auth.localhost"))) {
      throw new Error("Keycloak maintenance credentials must use the configured auth.localhost origin or an explicitly configured HTTPS origin");
    }
    return target.origin;
  }));
}

export function localKeycloakRequest(url, init = {}) {
  const target = new URL(url);
  if (target.username || target.password || target.hash || !configuredKeycloakOrigins().has(target.origin) ||
      (target.protocol === "http:" && target.hostname !== "auth.localhost")) {
    throw new Error("Keycloak maintenance credentials must use the configured auth.localhost origin or an explicitly configured HTTPS origin");
  }
  const headers = new Headers(init.headers);
  headers.delete("Host");
  if (target.protocol === "http:") {
    // Resolve browser-only *.localhost names to loopback in Node while keeping
    // the configured Host header for the gateway and Keycloak.
    headers.set("Host", target.host);
    target.hostname = "127.0.0.1";
  }
  return fetch(target, { ...init, headers, redirect: "manual" });
}

export async function connectLocalKeycloak() {
  loadProjectEnvironment();
  const port = process.env.KEYCLOAK_PORT || "1005";
  const adminPort = process.env.KEYCLOAK_ADMIN_PORT || "1009";
  for (const [name, value] of [["KEYCLOAK_PORT", port], ["KEYCLOAK_ADMIN_PORT", adminPort]]) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid local ${name}`);
  }
  const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim();
  const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    throw new Error("Set KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME and KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD in .env");
  }
  const base = new URL(process.env.KEYCLOAK_PUBLIC_URL?.trim() || `http://auth.localhost:${port}`).origin;
  const adminBase = new URL(process.env.KEYCLOAK_ADMIN_ORIGIN?.trim() ||
    process.env.KEYCLOAK_ADMIN_CONSOLE_URL?.trim() || `http://auth.localhost:${adminPort}`).origin;
  const login = await localKeycloakRequest(`${adminBase}/realms/master/protocol/openid-connect/token`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli",
      username: adminUsername, password: adminPassword }),
  });
  if (!login.ok) throw new Error(`Local administrator authentication failed (HTTP ${login.status})`);
  const { access_token } = await login.json();
  const createRealmApi = (realm) => async (path, { method = "GET", body } = {}) => {
    const response = await localKeycloakRequest(`${adminBase}/admin/realms/${realm}${path}`, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Keycloak ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`);
    return response;
  };
  return { base, adminBase, api: createRealmApi("inout") };
}

function requiredPasswordActionRedirectUris(client) {
  const standardCallbackUris = (Array.isArray(client?.redirectUris) ? client.redirectUris : [])
    .filter((uri) => typeof uri === "string" && uri.endsWith("/api/auth/callback/keycloak"));
  return [...new Set(standardCallbackUris.flatMap((uri) => PASSWORD_ACTION_PROVIDERS.map((action) =>
    uri.replace(/\/api\/auth\/callback\/keycloak$/, `/api/auth/callback/keycloak-password-${action}`))))];
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

export async function interactionProviderReady(api, adminBase, client, request = localKeycloakRequest,
  clientSecret = process.env.KEYCLOAK_CLIENT_SECRET) {
  if (client?.clientId !== "inout-frontend" || typeof client.id !== "string" || !client.id ||
      client.enabled !== true || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }
  if (typeof clientSecret !== "string" || !clientSecret || clientSecret.length > 4096) {
    throw new Error("Set KEYCLOAK_CLIENT_SECRET to the frontend application's configured credential");
  }
  const response = await request(`${adminBase}/realms/inout/inout-auth/status`, {
    method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: "Basic " + Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64") },
  });
  if (response.status !== 200 || Number(response.headers.get("Content-Length") || 0) > 4096) {
    void response.body?.cancel().catch(() => {});
    throw new Error("The authenticated app-interaction provider is not ready; rebuild and verify the pinned Keycloak extension first");
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) throw new Error("Invalid app-interaction readiness response");
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  let status;
  try { status = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid app-interaction readiness response"); }
  if (status?.protocol !== INTERACTION_PROTOCOL || status.extensionVersion !== INTERACTION_EXTENSION_VERSION ||
      status.keycloakVersion !== INTERACTION_KEYCLOAK_VERSION) {
    throw new Error("The app-interaction protocol or pinned Keycloak version does not match this application");
  }
  const policies = await (await api("/client-policies/policies?include-global-policies=true")).json();
  if (!policies || typeof policies !== "object" || Array.isArray(policies) || !Array.isArray(policies.policies) ||
      (policies.globalPolicies != null && !Array.isArray(policies.globalPolicies))) {
    throw new Error("Invalid OAuth client-policy readiness response");
  }
  const entries = [...policies.policies, ...(policies.globalPolicies || [])];
  if (entries.some(policy => !policy || typeof policy !== "object" || Array.isArray(policy) ||
      (policy.enabled != null && typeof policy.enabled !== "boolean"))) {
    throw new Error("Invalid OAuth client-policy readiness response");
  }
  if (entries.some(policy => policy.enabled === true)) {
    throw new Error("Enabled realm/global OAuth client policies require compatibility review before app interactions; no configuration was changed");
  }
  return true;
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

export function securePasswordPolicy(current = "") {
  const clauses = typeof current === "string" ? current.split(/\s+and\s+/).map(value => value.trim()).filter(Boolean) : [];
  const length = Math.max(12, ...clauses.flatMap(value => {
    const match = /^length\((\d+)\)$/.exec(value);
    return match ? [Number(match[1])] : [];
  }));
  const result = clauses.filter(value => !/^length\(/.test(value));
  result.unshift(`length(${length})`);
  for (const clause of ["notUsername(undefined)", "notEmail(undefined)", "passwordBlacklist(inout-common-passwords.txt)"]) {
    const name = clause.split("(")[0];
    if (!result.some(value => value === name || value.startsWith(`${name}(`))) result.push(clause);
  }
  return result.join(" and ");
}

export async function configurePasswordPolicy(api, { apply = false, log = console.log } = {}) {
  const realm = await (await api("")).json();
  const required = securePasswordPolicy(realm.passwordPolicy);
  if (realm.passwordPolicy === required) {
    log("Password policy: baseline strength configured");
    return true;
  }
  if (!apply) {
    log("Password policy: needs update (run with --apply)");
    return false;
  }
  await api("", { method: "PUT", body: { passwordPolicy: required } });
  const updated = await (await api("")).json();
  if (updated.passwordPolicy !== required) throw new Error("Keycloak did not persist the required password policy");
  log("Password policy: baseline strength applied; existing requirements preserved");
  return true;
}

export function missingApiAudienceMapper(existing) {
  if (existing.some((mapper) => mapper.protocol === "openid-connect" &&
    mapper.protocolMapper === "oidc-audience-mapper" &&
    mapper.config?.["included.client.audience"] === "inout-frontend" &&
    mapper.config?.["access.token.claim"] === "true")) return null;
  if (existing.some((mapper) => mapper.name === "api-audience")) {
    throw new Error("Existing api-audience mapper has conflicting settings; inspect it before repair");
  }
  const realm = JSON.parse(readFileSync(new URL("../keycloak/realm-inout.json", import.meta.url), "utf8"));
  const mapper = realm.clients.find((client) => client.clientId === "inout-frontend")
    ?.protocolMappers.find((candidate) => candidate.name === "api-audience");
  if (!mapper) throw new Error("The realm template must define the api-audience mapper");
  return mapper;
}

export async function hasDefaultAdminApiScope(api, clientId, scope) {
  const response = await api(`/clients/${encodeURIComponent(clientId)}/default-client-scopes`);
  const defaults = await response.json();
  if (!Array.isArray(defaults)) throw new Error("Keycloak returned an invalid default client scope list");
  return defaults.some((candidate) => candidate?.id === scope.id || candidate?.name === "kc-admin-api");
}

export async function addDefaultAdminApiScope(api, clientId, scope) {
  if (await hasDefaultAdminApiScope(api, clientId, scope)) return false;
  await api(`/clients/${encodeURIComponent(clientId)}/default-client-scopes/${encodeURIComponent(scope.id)}`, { method: "PUT" });
  if (!await hasDefaultAdminApiScope(api, clientId, scope)) throw new Error("Keycloak did not confirm the kc-admin-api default scope assignment");
  return true;
}

export function missingAccountRoles(existing, accountRoles, accountClientId) {
  const required = SELF_SERVICE_ROLES.map((name) => {
    const role = accountRoles.find((candidate) => candidate.name === name &&
      candidate.clientRole === true && candidate.containerId === accountClientId);
    if (!role?.id) throw new Error(`Missing built-in account role: ${name}`);
    return role;
  });
  return required.filter((role) => !existing.some((candidate) => candidate.id === role.id));
}

export function missingApplicationScopeRoles(existing, realmRoles) {
  const required = APPLICATION_ROLES.map((name) => {
    const role = realmRoles.find((candidate) => candidate.name === name && candidate.clientRole === false);
    if (!role?.id) throw new Error(`Missing application realm role: ${name}`);
    return role;
  });
  return required.filter((role) => !existing.some((candidate) => candidate.id === role.id));
}

export async function prepareApplicationClientScopes(api, clients) {
  const get = async (path) => (await api(path)).json();
  const realmRoles = [];
  for (const name of APPLICATION_ROLES) realmRoles.push(await get(`/roles/${name}`));
  const plans = [];
  for (const client of clients) {
    if (!client?.id || !["inout-frontend", "inout-postman"].includes(client.clientId)) {
      throw new Error("Application scope repair requires an existing application client");
    }
    const existing = await get(`/clients/${client.id}/scope-mappings/realm`);
    plans.push({ client, realmRoles, missing: missingApplicationScopeRoles(existing, realmRoles) });
  }
  return plans;
}

export async function applyApplicationClientScopes(api, plans) {
  for (const { client, realmRoles, missing } of plans) {
    if (missing.length) await api(`/clients/${client.id}/scope-mappings/realm`, { method: "POST", body: missing });
    const existing = await (await api(`/clients/${client.id}/scope-mappings/realm`)).json();
    if (missingApplicationScopeRoles(existing, realmRoles).length) throw new Error(`Application scope mapping repair failed for ${client.clientId}`);
  }
  for (const { client } of plans) {
    if (client.fullScopeAllowed !== false) await api(`/clients/${client.id}`, { method: "PUT", body: { fullScopeAllowed: false } });
    const updated = await (await api(`/clients/${client.id}`)).json();
    if (updated.fullScopeAllowed !== false) throw new Error(`Full scope remains enabled for ${client.clientId}`);
  }
}

export function missingFrontendRoleClaims(token, userRoleNames) {
  const missing = [];
  const roles = APPLICATION_ROLES.filter((name) => userRoleNames.includes(name));
  for (const name of roles) if (!token.realm_access?.roles?.includes(name)) missing.push(`realm:${name}`);
  if (roles.length) for (const name of SELF_SERVICE_ROLES) {
    if (!token.resource_access?.account?.roles?.includes(name)) missing.push(`account:${name}`);
  }
  if (roles.includes("zone-admin")) for (const name of DELEGATED_ADMIN_ROLES) {
    if (!token.resource_access?.["realm-management"]?.roles?.includes(name)) missing.push(`realm-management:${name}`);
  }
  return missing;
}

export async function repairKeycloakAccountAccess(api, base, { apply = false } = {}) {
  const expectedAdminApiAudience = `${base.replace(/\/+$/, "")}/admin/realms/inout`;
  const get = async (path) => (await api(path)).json();
  const [account] = await get("/clients?clientId=account");
  const [consoleClient] = await get("/clients?clientId=account-console");
  const [frontend] = await get("/clients?clientId=inout-frontend");
  const [postman] = await get("/clients?clientId=inout-postman");
  if (!account?.enabled || !consoleClient?.enabled) throw new Error("The built-in account and account-console clients must be enabled");
  if (!frontend?.enabled) throw new Error("The inout-frontend client must be enabled");
  const adminApiScopes = (await get("/client-scopes")).filter((scope) => scope?.name === "kc-admin-api");
  if (adminApiScopes.length !== 1 || !adminApiScopes[0]?.id) throw new Error("Keycloak must provide exactly one built-in kc-admin-api client scope (Keycloak 26.8 or newer)");
  const adminApiScope = adminApiScopes[0];
  let hasAdminApiScope = await hasDefaultAdminApiScope(api, frontend.id, adminApiScope);
  const audienceMapper = missingApiAudienceMapper(frontend.protocolMappers || []);
  const scopePlans = await prepareApplicationClientScopes(api, [frontend, ...(postman ? [postman] : [])]);
  const accountRoles = await get(`/clients/${account.id}/roles`);
  const plans = [];
  for (const name of ["zone-admin", "operator"]) {
    const existing = await get(`/roles/${name}/composites`);
    plans.push({ name, missing: missingAccountRoles(existing, accountRoles, account.id) });
  }
  console.log(`inout-frontend: API audience mapper ${audienceMapper ? "missing" : "present"}`);
  console.log(`inout-frontend: kc-admin-api default scope ${hasAdminApiScope ? "present" : "missing"}`);
  if (apply && !hasAdminApiScope) {
    await addDefaultAdminApiScope(api, frontend.id, adminApiScope);
    hasAdminApiScope = true;
    console.log("inout-frontend: assigned the built-in kc-admin-api scope required for delegated Admin REST requests");
  }
  if (apply && audienceMapper) {
    await api(`/clients/${frontend.id}/protocol-mappers/models`, { method: "POST", body: audienceMapper });
    console.log("inout-frontend: API audience mapper restored from realm template");
  }
  for (const { name, missing } of plans) {
    console.log(`${name}: ${missing.length ? `missing ${missing.map((role) => `account:${role.name}`).join(", ")}` : "self-service permissions present"}`);
    if (apply && missing.length) {
      await api(`/roles/${name}/composites`, { method: "POST", body: missing });
      const remaining = missingAccountRoles(await get(`/roles/${name}/composites`), accountRoles, account.id);
      if (remaining.length) throw new Error(`Self-service role repair failed for ${name}`);
      console.log(`${name}: self-service permissions added`);
    }
  }
  for (const { client, missing } of scopePlans) {
    console.log(`${client.clientId}: full scope ${client.fullScopeAllowed === false ? "disabled" : "enabled"}; ${missing.length ? `missing scope roles ${missing.map((role) => role.name).join(", ")}` : "application scope roles present"}`);
  }
  if (apply) {
    await applyApplicationClientScopes(api, scopePlans);
    console.log("Application clients: explicit role scope mappings verified; full scope disabled");
  }

  let checked = 0;
  let missingAudience = 0;
  let missingPermission = 0;
  let missingApiAudience = 0;
  let missingAdminApiAudience = 0;
  let missingAdminApiScope = 0;
  let missingFrontendClaims = 0;
  for (let first = 0; ; first += 100) {
    const users = await get(`/users?first=${first}&max=100`);
    for (const user of users) {
      const roles = await get(`/users/${user.id}/role-mappings/realm/composite`);
      if (!roles.some((role) => APPLICATION_ROLES.includes(role.name))) continue;
      const query = new URLSearchParams({ userId: user.id, scope: "openid" });
      const token = await get(`/clients/${consoleClient.id}/evaluate-scopes/generate-example-access-token?${query}`);
      checked++;
      if (![token.aud].flat().includes("account")) missingAudience++;
      if (!token.resource_access?.account?.roles?.includes("manage-account")) missingPermission++;
      const frontendToken = await get(`/clients/${frontend.id}/evaluate-scopes/generate-example-access-token?${query}`);
      if (![frontendToken.aud].flat().includes(process.env.KEYCLOAK_AUDIENCE || "inout-frontend")) missingApiAudience++;
      if (![frontendToken.aud].flat().includes(expectedAdminApiAudience)) missingAdminApiAudience++;
      if (frontendToken.scope?.split(/\s+/).includes("kc-admin-api") !== true) missingAdminApiScope++;
      if (missingFrontendRoleClaims(frontendToken, roles.map((role) => role.name)).length) missingFrontendClaims++;
    }
    if (users.length < 100) break;
  }
  console.log(JSON.stringify({ applicationUsersChecked: checked, missingAccountAudience: missingAudience, missingManageAccount: missingPermission, missingApiAudience, missingAdminApiAudience, missingAdminApiScope, missingFrontendClaims }));
  const configurationNeedsRepair = !hasAdminApiScope || Boolean(audienceMapper) ||
    plans.some(plan => plan.missing.length > 0) ||
    scopePlans.some(plan => plan.missing.length > 0 || plan.client.fullScopeAllowed !== false);
  if (missingAudience || missingPermission || missingApiAudience || missingAdminApiAudience || missingAdminApiScope || missingFrontendClaims ||
      (!apply && configurationNeedsRepair)) {
    if (apply) throw new Error("Tokens still lack required claims; inspect client scopes, mappers, and KEYCLOAK_AUDIENCE");
    console.log("Run with --apply to repair account permissions, API audiences and scope, and explicit application role scopes.");
    return false;
  }
  return true;
}

export async function configureMasterAdmin(api, { apply = false } = {}) {
  const get = async (path) => (await api(path)).json();
  let realmRoles = await get("/roles");
  const zoneAdminRole = realmRoles.find((role) => role.name === "zone-admin");
  if (!zoneAdminRole?.id) throw new Error("The InOut zone-admin realm role is missing");
  let masterRole = realmRoles.find((role) => role.name === "master-admin");
  const [frontend] = await get("/clients?clientId=inout-frontend");
  if (!frontend?.id) throw new Error("The inout-frontend client is missing");
  if (!masterRole && apply) {
    await api("/roles", { method: "POST", body: {
      name: "master-admin",
      description: "Manage admin and operator accounts and checkpoint assignments",
    } });
    realmRoles = await get("/roles");
    masterRole = realmRoles.find((role) => role.name === "master-admin");
    if (!masterRole?.id) throw new Error("Keycloak did not create the master-admin realm role");
  }
  const hasRole = (roles, expected) => roles.some((role) => (expected.id && role.id === expected.id) || role.name === expected.name);
  let composites = masterRole?.id ? await get(`/roles/${encodeURIComponent(masterRole.name)}/composites`) : [];
  let scopeRoles = await get(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`);
  let needsZoneAdminComposite = Boolean(masterRole && !hasRole(composites, zoneAdminRole));
  let needsFrontendScope = Boolean(masterRole && !hasRole(scopeRoles, masterRole));
  if (apply && masterRole && needsZoneAdminComposite) {
    await api(`/roles/${encodeURIComponent(masterRole.name)}/composites`, { method: "POST", body: [zoneAdminRole] });
    composites = await get(`/roles/${encodeURIComponent(masterRole.name)}/composites`);
    needsZoneAdminComposite = !hasRole(composites, zoneAdminRole);
    if (needsZoneAdminComposite) throw new Error("Keycloak did not add zone-admin as a master-admin composite");
  }
  if (apply && masterRole && needsFrontendScope) {
    await api(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`, { method: "POST", body: [masterRole] });
    scopeRoles = await get(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`);
    needsFrontendScope = !hasRole(scopeRoles, masterRole);
    if (needsFrontendScope) throw new Error("Keycloak did not expose master-admin in frontend tokens");
  }
  const ready = Boolean(masterRole && !needsZoneAdminComposite && !needsFrontendScope);
  return { ready, roleExists: Boolean(masterRole), zoneAdminComposite: Boolean(masterRole) && !needsZoneAdminComposite,
    frontendScope: Boolean(masterRole) && !needsFrontendScope };
}

function configuredApplicationUrl() {
  const configured = process.env.AUTH_URL || process.env.INOUT_APP_URL ||
    `http://app.localhost:${process.env.APP_PORT || "1008"}`;
  let url;
  try { url = new URL(configured); } catch { throw new Error("AUTH_URL must be a complete application origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUTH_URL must be an HTTP(S) application origin without a path.");
  }
  return url.origin;
}

export function requiredApplicationClientUrls(origin) {
  const base = origin.replace(/\/$/, "");
  return {
    redirectUris: [`${base}/api/auth/callback/keycloak`, `${base}/api/auth/callback/keycloak-password-setup`, `${base}/api/auth/callback/keycloak-password-change`],
    webOrigins: [base],
    postLogoutRedirectUris: [`${base}/login`, `${base}/logout/complete`],
  };
}

export async function configurePublicApplicationUrls(api, { origin = configuredApplicationUrl(), apply = false, log = console.log } = {}) {
  const matches = await (await api("/clients?clientId=inout-frontend")).json();
  const clients = matches.filter(client => client.clientId === "inout-frontend");
  if (clients.length !== 1 || !clients[0]?.id) throw new Error("Exactly one inout-frontend client is required");
  const path = `/clients/${encodeURIComponent(clients[0].id)}`;
  const client = await (await api(path)).json();
  if (!client?.enabled || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }
  const required = requiredApplicationClientUrls(origin);
  const redirectUris = [...new Set([...(client.redirectUris || []), ...required.redirectUris])];
  const webOrigins = [...new Set([...(client.webOrigins || []), ...required.webOrigins])];
  const currentLogoutUris = (client.attributes?.["post.logout.redirect.uris"] || "").split("##").map(uri => uri.trim()).filter(Boolean);
  const logoutUris = [...new Set([...currentLogoutUris, ...required.postLogoutRedirectUris])];
  const attributes = { ...client.attributes, "post.logout.redirect.uris": logoutUris.join("##") };
  const changed = redirectUris.length !== (client.redirectUris || []).length || webOrigins.length !== (client.webOrigins || []).length ||
    attributes["post.logout.redirect.uris"] !== client.attributes?.["post.logout.redirect.uris"];
  if (!changed) { log(`inout-frontend: public callbacks and origins are configured for ${origin}`); return true; }
  if (!apply) { log(`inout-frontend: public callback/origin settings need updating for ${origin} (run with --apply)`); return false; }
  await api(path, { method: "PUT", body: { redirectUris, webOrigins, attributes } });
  const updated = await (await api(path)).json();
  const actual = requiredApplicationClientUrls(origin);
  const actualLogoutUris = (updated.attributes?.["post.logout.redirect.uris"] || "").split("##");
  if (!actual.redirectUris.every(uri => updated.redirectUris?.includes(uri)) ||
      !actual.webOrigins.every(uri => updated.webOrigins?.includes(uri)) ||
      !actual.postLogoutRedirectUris.every(uri => actualLogoutUris.includes(uri))) {
    throw new Error("Keycloak did not confirm all public application URLs");
  }
  log(`inout-frontend: added exact public callback/origin URLs for ${origin}; existing values were preserved`);
  return true;
}

export const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const REQUIRED_USER_EVENT_TYPES = [
  "LOGIN", "LOGIN_ERROR", "LOGOUT", "CODE_TO_TOKEN", "CODE_TO_TOKEN_ERROR", "REFRESH_TOKEN_ERROR",
  "UPDATE_CREDENTIAL", "UPDATE_CREDENTIAL_ERROR", "UPDATE_PASSWORD", "UPDATE_PASSWORD_ERROR",
  "RESET_PASSWORD", "RESET_PASSWORD_ERROR", "UPDATE_TOTP", "UPDATE_TOTP_ERROR", "REMOVE_TOTP", "REMOVE_TOTP_ERROR",
];

export function keycloakAuditSettings(realm) {
  const currentTypes = Array.isArray(realm.enabledEventTypes) ? realm.enabledEventTypes : [];
  const eventTypes = realm.eventsEnabled === true && currentTypes.length === 0
    ? [] : [...new Set([...currentTypes, ...REQUIRED_USER_EVENT_TYPES])].sort();
  const currentRetention = Number.isFinite(realm.eventsExpiration) ? realm.eventsExpiration : 0;
  const currentAdminRetention = Number(realm.attributes?.adminEventsExpiration) || 0;
  return {
    eventsEnabled: true,
    eventsExpiration: Math.max(currentRetention, EVENT_RETENTION_SECONDS),
    enabledEventTypes: eventTypes,
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: false,
    attributes: { ...(realm.attributes || {}), adminEventsExpiration: String(Math.max(currentAdminRetention, EVENT_RETENTION_SECONDS)) },
  };
}

export function keycloakAuditReady(realm) {
  const types = Array.isArray(realm.enabledEventTypes) ? realm.enabledEventTypes : [];
  const allTypesEnabled = realm.eventsEnabled === true && types.length === 0;
  return realm.eventsEnabled === true && Number(realm.eventsExpiration) >= EVENT_RETENTION_SECONDS &&
    Number(realm.attributes?.adminEventsExpiration) >= EVENT_RETENTION_SECONDS &&
    (allTypesEnabled || REQUIRED_USER_EVENT_TYPES.every(type => types.includes(type))) &&
    realm.adminEventsEnabled === true && realm.adminEventsDetailsEnabled !== true;
}

export async function configureKeycloakAudit(api, { apply = false, log = console.log } = {}) {
  let realm = await (await api("")).json();
  if (keycloakAuditReady(realm)) { log("Keycloak event auditing: configured with bounded retention"); return true; }
  if (!apply) { log("Keycloak event auditing: needs configuration (run with --apply)"); return false; }
  await api("", { method: "PUT", body: keycloakAuditSettings(realm) });
  realm = await (await api("")).json();
  if (!keycloakAuditReady(realm)) throw new Error("Keycloak did not confirm the requested audit-event settings");
  log("Keycloak event auditing: applied with 30-day minimum retention");
  return true;
}

export const INVITATION_CLIENT_ID = "inout-invitations";
export const ZOHO_INVITATION_FLOW_ALIAS = "inout-zoho-invitation-gate";
const ZOHO_INVITATION_AUTHENTICATORS = [
  "idp-detect-existing-broker-user",
  "idp-auto-link",
];
const INVITATION_MANAGEMENT_ROLES = ["manage-users", "query-users", "view-users"];
const INVITATION_APPLICATION_ROLES = new Set(["admin", "zone-admin", "master-admin", "operator"]);
const DEFAULT_REALM_ROLES = new Set(["default-roles-inout", "offline_access", "uma_authorization"]);
const INVITATION_CLIENT_CONFIGURATION = {
  publicClient: false, protocol: "openid-connect", clientAuthenticatorType: "client-secret",
  standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true, fullScopeAllowed: false, redirectUris: [], webOrigins: [],
};
const INVITATION_PROFILE_ATTRIBUTES = [
  { name: "invite_status", displayName: "Invitation status" },
  { name: "invite_nonce_hash", displayName: "Invitation token hash" },
  { name: "invite_expires_at", displayName: "Invitation expiry" },
].map(attribute => ({
  ...attribute,
  permissions: { view: ["admin"], edit: ["admin"] },
  multivalued: false,
}));

const sameSet = (left, right) => Array.isArray(left) && left.length === right.length &&
  new Set(left).size === right.length && right.every(value => left.includes(value));

async function invitationDocument(api, path) {
  const value = await (await api(path)).json();
  if (!value || typeof value !== "object") throw new Error("Invalid invitation-client configuration response");
  return value;
}

function invitationProfileAttributesReady(profile) {
  if (!Array.isArray(profile?.attributes)) return false;
  return INVITATION_PROFILE_ATTRIBUTES.every(expected => {
    const matches = profile.attributes.filter(attribute => attribute?.name === expected.name);
    if (matches.length !== 1) return false;
    const attribute = matches[0];
    const required = attribute.required;
    const isRequired = [required?.roles, required?.scopes].some(values => Array.isArray(values) && values.length > 0);
    return attribute.displayName === expected.displayName && attribute.multivalued === false && !isRequired &&
      sameSet(attribute.permissions?.view, ["admin"]) && sameSet(attribute.permissions?.edit, ["admin"]);
  });
}

async function configureInvitationProfileAttributes(api, { apply = false, log = console.log } = {}) {
  const profile = await invitationDocument(api, "/users/profile");
  if (!Array.isArray(profile.attributes)) throw new Error("Keycloak returned an invalid user-profile attribute list");
  const counts = new Map();
  for (const attribute of profile.attributes) {
    if (INVITATION_PROFILE_ATTRIBUTES.some(expected => expected.name === attribute?.name)) {
      counts.set(attribute.name, (counts.get(attribute.name) || 0) + 1);
    }
  }
  if ([...counts.values()].some(count => count > 1)) throw new Error("Keycloak has duplicate invitation user-profile attributes; inspect them before repair");
  if (invitationProfileAttributesReady(profile)) {
    log("Invitation user profile: hidden admin-only invitation fields configured");
    return true;
  }
  if (!apply) {
    log("Invitation user profile: invitation fields need setup (run with --apply)");
    return false;
  }

  const attributes = [...profile.attributes];
  for (const expected of INVITATION_PROFILE_ATTRIBUTES) {
    const index = attributes.findIndex(attribute => attribute?.name === expected.name);
    if (index < 0) {
      attributes.push(expected);
      continue;
    }
    const updated = { ...attributes[index], ...expected };
    delete updated.required;
    attributes[index] = updated;
  }
  await api("/users/profile", { method: "PUT", body: { ...profile, attributes } });
  const verified = await invitationDocument(api, "/users/profile");
  if (!invitationProfileAttributesReady(verified)) throw new Error("Keycloak did not confirm the admin-only invitation user-profile fields");
  log("Invitation user profile: hidden admin-only invitation fields configured");
  return true;
}

async function findInvitationClient(api, clientId) {
  const clients = await invitationDocument(api, `/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!Array.isArray(clients)) throw new Error("Invalid Keycloak client listing");
  const matches = clients.filter(client => client.clientId === clientId);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error(`Ambiguous ${clientId} client listing`);
  return matches[0] ?? null;
}

function invitationClientReady(client) {
  return client?.enabled === true && Object.entries(INVITATION_CLIENT_CONFIGURATION).every(([key, value]) =>
    Array.isArray(value) ? sameSet(client[key] ?? [], value) : client[key] === value);
}

export async function configureZohoInvitationBroker(api, { apply = false, idpAlias = process.env.KEYCLOAK_ZOHO_IDP_ALIAS || "zoho", log = console.log } = {}) {
  if (typeof idpAlias !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(idpAlias)) {
    throw new Error("KEYCLOAK_ZOHO_IDP_ALIAS must be a valid Keycloak identity-provider alias");
  }
  const [providers, authenticators] = await Promise.all([
    invitationDocument(api, "/identity-provider/instances"),
    invitationDocument(api, "/authentication/authenticator-providers"),
  ]);
  if (!Array.isArray(providers) || !Array.isArray(authenticators)) {
    throw new Error("Keycloak returned an invalid Zoho broker configuration");
  }
  const matches = providers.filter(provider => provider.alias === idpAlias);
  if (matches.length !== 1) {
    log(`Invitation gate: configure the Zoho OIDC provider with alias '${idpAlias}' before applying this setup`);
    return false;
  }
  let provider = matches[0];
  if (provider.providerId !== "oidc") throw new Error(`Identity provider '${idpAlias}' must use OpenID Connect`);
  if (provider.trustEmail !== true) {
    log(`Invitation gate: enable Trust Email for '${idpAlias}' only after confirming Zoho supplies verified email claims`);
    return false;
  }
  const available = new Set(authenticators.map(authenticator => authenticator.id));
  if (ZOHO_INVITATION_AUTHENTICATORS.some(id => !available.has(id))) {
    throw new Error("This Keycloak version does not provide the required existing-user broker authenticators");
  }

  const flows = await invitationDocument(api, "/authentication/flows");
  if (!Array.isArray(flows)) throw new Error("Keycloak returned an invalid authentication-flow list");
  let flow = flows.find(candidate => candidate.alias === ZOHO_INVITATION_FLOW_ALIAS) ?? null;
  if (!flow) {
    if (!apply) {
      log(`Invitation gate: ${ZOHO_INVITATION_FLOW_ALIAS} needs setup (run with --apply)`);
      return false;
    }
    await api("/authentication/flows", { method: "POST", body: {
      alias: ZOHO_INVITATION_FLOW_ALIAS,
      description: "Only link Zoho identities to existing invited InOut accounts.",
      providerId: "basic-flow", topLevel: true, builtIn: false,
    } });
    const savedFlows = await invitationDocument(api, "/authentication/flows");
    flow = savedFlows.find(candidate => candidate.alias === ZOHO_INVITATION_FLOW_ALIAS) ?? null;
    if (!flow) throw new Error("Keycloak did not create the Zoho invitation flow");
  }
  if (flow.builtIn === true || flow.providerId !== "basic-flow" || flow.topLevel !== true || typeof flow.id !== "string") {
    throw new Error(`The '${ZOHO_INVITATION_FLOW_ALIAS}' flow is not the expected app-managed top-level flow; inspect it before changing it`);
  }

  let executions = await invitationDocument(api, `/authentication/flows/${encodeURIComponent(ZOHO_INVITATION_FLOW_ALIAS)}/executions`);
  if (!Array.isArray(executions)) throw new Error("Keycloak returned invalid Zoho invitation-flow executions");
  const unexpected = executions.filter(execution => !ZOHO_INVITATION_AUTHENTICATORS.includes(execution.providerId));
  if (unexpected.length || executions.some(execution => execution.authenticationFlow === true || execution.level !== 0)) {
    throw new Error(`The '${ZOHO_INVITATION_FLOW_ALIAS}' flow contains unexpected executions; inspect it before repair`);
  }
  if (executions.some(execution => ZOHO_INVITATION_AUTHENTICATORS.filter(id => id === execution.providerId).length > 1)) {
    throw new Error(`The '${ZOHO_INVITATION_FLOW_ALIAS}' flow has duplicate authenticators; inspect it before repair`);
  }
  for (const authenticator of ZOHO_INVITATION_AUTHENTICATORS) {
    if (executions.some(execution => execution.providerId === authenticator)) continue;
    if (!apply) {
      log(`Invitation gate: ${authenticator} needs setup (run with --apply)`);
      return false;
    }
    await api(`/authentication/flows/${encodeURIComponent(ZOHO_INVITATION_FLOW_ALIAS)}/executions/execution`, {
      method: "POST", body: { provider: authenticator },
    });
    executions = await invitationDocument(api, `/authentication/flows/${encodeURIComponent(ZOHO_INVITATION_FLOW_ALIAS)}/executions`);
    if (!Array.isArray(executions)) throw new Error("Keycloak returned invalid Zoho invitation-flow executions");
  }
  for (const authenticator of ZOHO_INVITATION_AUTHENTICATORS) {
    const execution = executions.find(candidate => candidate.providerId === authenticator);
    if (!execution || typeof execution.id !== "string") throw new Error(`Keycloak did not create the ${authenticator} execution`);
    if (execution.requirement !== "REQUIRED") {
      if (!apply) {
        log(`Invitation gate: ${authenticator} must be required (run with --apply)`);
        return false;
      }
      await api(`/authentication/flows/${encodeURIComponent(ZOHO_INVITATION_FLOW_ALIAS)}/executions`, {
        method: "PUT", body: { ...execution, requirement: "REQUIRED" },
      });
      executions = await invitationDocument(api, `/authentication/flows/${encodeURIComponent(ZOHO_INVITATION_FLOW_ALIAS)}/executions`);
    }
  }
  const expectedExecutions = executions.filter(execution => execution.level === 0).map(execution => execution.providerId);
  if (expectedExecutions.length !== ZOHO_INVITATION_AUTHENTICATORS.length ||
      expectedExecutions.some((id, index) => id !== ZOHO_INVITATION_AUTHENTICATORS[index]) ||
      executions.some(execution => execution.requirement !== "REQUIRED")) {
    throw new Error("Keycloak did not confirm the ordered, required invitation-only Zoho flow");
  }

  if (provider.firstBrokerLoginFlowAlias !== ZOHO_INVITATION_FLOW_ALIAS) {
    if (!apply) {
      log(`Invitation gate: Zoho provider '${idpAlias}' is not bound to the invitation-only flow (run with --apply)`);
      return false;
    }
    await api(`/identity-provider/instances/${encodeURIComponent(idpAlias)}`, {
      method: "PUT", body: { ...provider, firstBrokerLoginFlowAlias: ZOHO_INVITATION_FLOW_ALIAS },
    });
    provider = await invitationDocument(api, `/identity-provider/instances/${encodeURIComponent(idpAlias)}`);
  }
  if (provider.firstBrokerLoginFlowAlias !== ZOHO_INVITATION_FLOW_ALIAS) {
    throw new Error("Keycloak did not bind the Zoho provider to the invitation-only first-login flow");
  }
  log(`Invitation gate: Zoho provider '${idpAlias}' requires a matching existing Keycloak account`);
  return true;
}

export async function configureInvitationClient(api, { apply = false, clientSecret, log = console.log } = {}) {
  if (typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(clientSecret)) {
    throw new Error("Set KEYCLOAK_INVITE_CLIENT_SECRET to an independent random URL-safe secret of at least 32 characters");
  }
  const needsRepair = () => { log("Invitations: server-only Keycloak client needs setup (run with --apply)"); return false; };
  if (!await configureInvitationProfileAttributes(api, { apply, log })) return false;
  let client = await findInvitationClient(api, INVITATION_CLIENT_ID);
  if (!client) {
    if (!apply) return needsRepair();
    await api("/clients", { method: "POST", body: {
      clientId: INVITATION_CLIENT_ID, name: "InOut invitation acceptance",
      description: "Server-only account activation for single-use invitations.",
      ...INVITATION_CLIENT_CONFIGURATION, enabled: false, secret: clientSecret,
    } });
    client = await findInvitationClient(api, INVITATION_CLIENT_ID);
    if (!client) throw new Error("Keycloak did not create the invitation service client");
  }
  client = await invitationDocument(api, `/clients/${encodeURIComponent(client.id)}`);
  if (client.protocol !== "openid-connect" || client.publicClient !== false) throw new Error("The invitation service must be a confidential OIDC client");
  const clientPath = `/clients/${encodeURIComponent(client.id)}`;
  const adminApiScopes = (await invitationDocument(api, "/client-scopes")).filter(scope => scope?.name === "kc-admin-api");
  if (adminApiScopes.length !== 1 || !adminApiScopes[0]?.id) {
    throw new Error("Keycloak must provide exactly one built-in kc-admin-api client scope (Keycloak 26.8 or newer)");
  }
  const hasAdminApiScope = await hasDefaultAdminApiScope(api, client.id, adminApiScopes[0]);
  if (!hasAdminApiScope && !apply) return needsRepair();
  if (!hasAdminApiScope) await addDefaultAdminApiScope(api, client.id, adminApiScopes[0]);
  const savedSecret = await invitationDocument(api, `${clientPath}/client-secret`);
  if (savedSecret.value !== clientSecret) throw new Error("KEYCLOAK_INVITE_CLIENT_SECRET does not match the existing client; preserve its secret or coordinate a separate rotation");
  if (!invitationClientReady(client)) {
    if (!apply) return needsRepair();
    await api(clientPath, { method: "PUT", body: { ...INVITATION_CLIENT_CONFIGURATION, enabled: false } });
    client = await invitationDocument(api, clientPath);
  }
  const serviceUser = await invitationDocument(api, `${clientPath}/service-account-user`);
  if (typeof serviceUser.id !== "string" || !serviceUser.id || serviceUser.username !== `service-account-${INVITATION_CLIENT_ID}`) {
    throw new Error("Keycloak did not confirm the invitation service account");
  }
  const management = await findInvitationClient(api, "realm-management");
  if (!management) throw new Error("Keycloak realm-management client is missing");
  const [realmMappings, managementMappings] = await Promise.all([
    invitationDocument(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/realm`),
    invitationDocument(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`),
  ]);
  if (!Array.isArray(realmMappings) || !Array.isArray(managementMappings) ||
      realmMappings.some(role => INVITATION_APPLICATION_ROLES.has(role.name) || !DEFAULT_REALM_ROLES.has(role.name))) {
    throw new Error("Invitation service account has unexpected realm role mappings; inspect it before provisioning");
  }
  const currentNames = new Set(managementMappings.map(role => role.name));
  if ([...currentNames].some(name => !INVITATION_MANAGEMENT_ROLES.includes(name))) throw new Error("Invitation service account has unexpected realm-management roles; remove them before provisioning");
  const expectedRoleModels = [];
  const roleModels = [];
  for (const name of INVITATION_MANAGEMENT_ROLES) {
    const role = await invitationDocument(api, `/clients/${encodeURIComponent(management.id)}/roles/${encodeURIComponent(name)}`);
    if (typeof role.id !== "string" || !role.id) throw new Error(`Keycloak is missing the ${name} role`);
    expectedRoleModels.push(role);
    if (!currentNames.has(name)) roleModels.push(role);
  }
  if (roleModels.length && !apply) return needsRepair();
  if (roleModels.length) await api(`/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`, { method: "POST", body: roleModels });
  const verifiedMappings = await invitationDocument(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}`);
  if (!Array.isArray(verifiedMappings) || !sameSet(verifiedMappings.map(role => role.name), INVITATION_MANAGEMENT_ROLES)) throw new Error("Keycloak did not confirm the invitation service account restricted roles");
  // A client with Full Scope Allowed disabled must explicitly include its
  // assigned realm-management roles in its role scope mappings. Service-account
  // role assignments alone do not place those roles in its access token.
  const managementScopePath = `${clientPath}/scope-mappings/clients/${encodeURIComponent(management.id)}`;
  const currentScopeMappings = await invitationDocument(api, managementScopePath);
  if (!Array.isArray(currentScopeMappings) || currentScopeMappings.some(role => !INVITATION_MANAGEMENT_ROLES.includes(role.name))) {
    throw new Error("Invitation client has unexpected realm-management role scopes; inspect them before provisioning");
  }
  const currentScopeNames = new Set(currentScopeMappings.map(role => role.name));
  const missingScopeRoles = expectedRoleModels.filter(role => !currentScopeNames.has(role.name));
  if (missingScopeRoles.length && !apply) return needsRepair();
  if (missingScopeRoles.length) await api(managementScopePath, { method: "POST", body: missingScopeRoles });
  const verifiedScopeMappings = await invitationDocument(api, managementScopePath);
  if (!Array.isArray(verifiedScopeMappings) || !sameSet(verifiedScopeMappings.map(role => role.name), INVITATION_MANAGEMENT_ROLES)) {
    throw new Error("Keycloak did not confirm the invitation client role scopes");
  }
  if (!invitationClientReady(client)) {
    if (!apply) return needsRepair();
    await api(clientPath, { method: "PUT", body: { enabled: true } });
    client = await invitationDocument(api, clientPath);
  }
  if (!invitationClientReady(client)) throw new Error("Keycloak did not confirm the server-only invitation client configuration");
  if (!await configureZohoInvitationBroker(api, { apply, log })) return false;
  log("Invitations: server-only service account configured with user-management access");
  return true;
}

export const PASSWORD_UPDATE_CLIENT_ID = "inout-password-updates";
const PASSWORD_UPDATE_POLICY_NAME = "inout-password-updates-service";
const PASSWORD_UPDATE_PERMISSION_NAME = "inout-password-updates-users";
const PASSWORD_UPDATE_DESCRIPTION = "Managed by IN / OUT password-update provisioning.";
const PASSWORD_UPDATE_APPLICATION_ROLES = new Set(["admin", "zone-admin", "master-admin", "operator"]);
const PASSWORD_UPDATE_CLIENT_CONFIGURATION = {
  publicClient: false, protocol: "openid-connect", clientAuthenticatorType: "client-secret",
  standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true, fullScopeAllowed: false, redirectUris: [], webOrigins: [],
};

export function passwordUpdateClientReady(client) {
  return client?.enabled === true && Object.entries(PASSWORD_UPDATE_CLIENT_CONFIGURATION).every(([key, value]) =>
    Array.isArray(value) ? sameSet(client[key] ?? [], value) : client[key] === value);
}

async function passwordUpdateDocument(api, path, options) {
  const value = await (await api(path, options)).json();
  if (!value || typeof value !== "object") throw new Error("Invalid password-update configuration response");
  return value;
}

async function exactPasswordUpdateClient(api, clientId) {
  const clients = await passwordUpdateDocument(api, `/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!Array.isArray(clients)) throw new Error("Invalid identity client listing");
  const matches = clients.filter(client => client.clientId === clientId);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error("Ambiguous password-update identity client");
  return matches[0] ?? null;
}

async function assertPasswordUpdateServiceRoles(api, serviceUser, management) {
  const realmRoles = await passwordUpdateDocument(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/realm/composite`);
  const clientRoles = await passwordUpdateDocument(api, `/users/${encodeURIComponent(serviceUser.id)}/role-mappings/clients/${encodeURIComponent(management.id)}/composite`);
  if (!Array.isArray(realmRoles) || !Array.isArray(clientRoles) || clientRoles.length ||
      realmRoles.some(role => PASSWORD_UPDATE_APPLICATION_ROLES.has(role.name))) {
    throw new Error("Password-update service account has unexpected application or administration roles; remove them before provisioning");
  }
}

async function namedPasswordUpdateDocument(api, base, name) {
  const documents = await passwordUpdateDocument(api, `${base}?name=${encodeURIComponent(name)}`);
  if (!Array.isArray(documents)) throw new Error("Invalid password-update permission listing");
  const matches = documents.filter(value => value.name === name);
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id)) throw new Error("Ambiguous password-update permission configuration");
  return matches[0] ?? null;
}

function passwordUpdatePolicyUsers(policy) {
  if (Array.isArray(policy.users)) return policy.users;
  try { return JSON.parse(policy.config?.users ?? "null"); } catch { return null; }
}

async function passwordUpdatePermissionDocument(api, base, id) {
  const path = `${base}/${encodeURIComponent(id)}`;
  const [permission, resources, policies] = await Promise.all([
    passwordUpdateDocument(api, `${path}?fields=*`), passwordUpdateDocument(api, `${path}/resources`),
    passwordUpdateDocument(api, `${path}/associatedPolicies`),
  ]);
  if (!Array.isArray(resources) || !Array.isArray(policies)) throw new Error("Invalid password-update permission associations");
  return { ...permission, resources, policies: policies.map(policy => policy.id) };
}

export async function configurePasswordUpdates(api, { apply = false, clientSecret, log = console.log } = {}) {
  if (typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(clientSecret)) {
    throw new Error("Set KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET to an independent random URL-safe secret of at least 32 characters");
  }
  const needsRepair = () => { log("Password updates: server-only native API configuration needs repair (run with --apply)"); return false; };
  let client = await exactPasswordUpdateClient(api, PASSWORD_UPDATE_CLIENT_ID);
  if (!client) {
    if (!apply) return needsRepair();
    await api("/clients", { method: "POST", body: {
      clientId: PASSWORD_UPDATE_CLIENT_ID, name: "InOut password updates", description: PASSWORD_UPDATE_DESCRIPTION,
      ...PASSWORD_UPDATE_CLIENT_CONFIGURATION, enabled: false, secret: clientSecret,
    } });
    client = await exactPasswordUpdateClient(api, PASSWORD_UPDATE_CLIENT_ID);
    if (!client) throw new Error("Keycloak did not create the password-update service client");
  }
  client = await passwordUpdateDocument(api, `/clients/${encodeURIComponent(client.id)}`);
  if (client.protocol !== "openid-connect" || client.publicClient !== false) throw new Error("Password updates require the dedicated confidential OIDC service client");
  const path = `/clients/${encodeURIComponent(client.id)}`;
  const savedSecret = await passwordUpdateDocument(api, `${path}/client-secret`);
  if (savedSecret.value !== clientSecret) throw new Error("KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET does not match the existing client; preserve its secret or coordinate a separate rotation");
  if (!passwordUpdateClientReady(client)) {
    if (!apply) return needsRepair();
    await api(path, { method: "PUT", body: { ...PASSWORD_UPDATE_CLIENT_CONFIGURATION, enabled: false } });
    client = await passwordUpdateDocument(api, path);
  }
  const serviceUser = await passwordUpdateDocument(api, `${path}/service-account-user`);
  if (typeof serviceUser.id !== "string" || !serviceUser.id || serviceUser.username !== `service-account-${PASSWORD_UPDATE_CLIENT_ID}`) throw new Error("Keycloak did not confirm the dedicated password-update service account");
  const management = await exactPasswordUpdateClient(api, "realm-management");
  if (!management) throw new Error("Missing built-in realm-management client");
  await assertPasswordUpdateServiceRoles(api, serviceUser, management);
  let realm = await passwordUpdateDocument(api, "");
  if (realm.adminPermissionsEnabled !== true) {
    if (!apply) return needsRepair();
    await api("", { method: "PUT", body: { adminPermissionsEnabled: true } });
    realm = await passwordUpdateDocument(api, "");
    if (realm.adminPermissionsEnabled !== true) throw new Error("Keycloak did not enable fine-grained administration permissions");
  }
  const permissionsClient = await exactPasswordUpdateClient(api, "admin-permissions");
  if (!permissionsClient) throw new Error("Keycloak did not create the fine-grained administration client");
  const authorization = `/clients/${encodeURIComponent(permissionsClient.id)}/authz/resource-server`;
  const desiredPolicy = { name: PASSWORD_UPDATE_POLICY_NAME, description: PASSWORD_UPDATE_DESCRIPTION, type: "user", logic: "POSITIVE", users: [serviceUser.id] };
  let listedPolicy = await namedPasswordUpdateDocument(api, `${authorization}/policy`, PASSWORD_UPDATE_POLICY_NAME);
  let policy = listedPolicy ? await passwordUpdateDocument(api, `${authorization}/policy/user/${encodeURIComponent(listedPolicy.id)}`) : null;
  if (policy && (policy.type !== "user" || policy.description !== PASSWORD_UPDATE_DESCRIPTION)) throw new Error("Existing password-update policy is not owned by this configuration; inspect it before repair");
  if (!policy || policy.logic !== "POSITIVE" || !sameSet(passwordUpdatePolicyUsers(policy), desiredPolicy.users)) {
    if (!apply) return needsRepair();
    await api(`${authorization}/policy/user${policy ? `/${encodeURIComponent(policy.id)}` : ""}`, {
      method: policy ? "PUT" : "POST", body: { ...desiredPolicy, ...(policy ? { id: policy.id } : {}) },
    });
    listedPolicy = await namedPasswordUpdateDocument(api, `${authorization}/policy`, PASSWORD_UPDATE_POLICY_NAME);
    if (!listedPolicy) throw new Error("Keycloak did not persist the password-update policy");
    policy = await passwordUpdateDocument(api, `${authorization}/policy/user/${encodeURIComponent(listedPolicy.id)}`);
  }
  if (policy.type !== "user" || policy.logic !== "POSITIVE" || !sameSet(passwordUpdatePolicyUsers(policy), desiredPolicy.users)) throw new Error("Keycloak did not confirm the restricted service-account policy");
  const desiredPermission = { name: PASSWORD_UPDATE_PERMISSION_NAME, description: PASSWORD_UPDATE_DESCRIPTION, type: "scope", logic: "POSITIVE",
    decisionStrategy: "UNANIMOUS", resourceType: "Users", resources: [], scopes: ["view", "reset-password"], policies: [policy.id] };
  let listedPermission = await namedPasswordUpdateDocument(api, `${authorization}/permission/scope`, PASSWORD_UPDATE_PERMISSION_NAME);
  let permission = listedPermission ? await passwordUpdatePermissionDocument(api, `${authorization}/permission/scope`, listedPermission.id) : null;
  if (permission && (permission.type !== "scope" || permission.description !== PASSWORD_UPDATE_DESCRIPTION)) throw new Error("Existing password-update permission is not owned by this configuration; inspect it before repair");
  const scopes = await passwordUpdateDocument(api, `${authorization}/scope`);
  if (!Array.isArray(scopes)) throw new Error("Invalid administration scope catalog");
  const names = values => Array.isArray(values) ? values.map(value => scopes.find(scope => scope.id === value)?.name ?? value) : null;
  const permissionReady = value => value?.type === "scope" && value.description === PASSWORD_UPDATE_DESCRIPTION && value.resourceType === "Users" &&
    value.logic === "POSITIVE" && value.decisionStrategy === "UNANIMOUS" && Array.isArray(value.resources) && value.resources.length === 1 &&
    value.resources[0].name === "Users" && sameSet(names(value.scopes), desiredPermission.scopes) && sameSet(value.policies, [policy.id]);
  if (!permissionReady(permission)) {
    if (!apply) return needsRepair();
    await api(`${authorization}/permission/scope${permission ? `/${encodeURIComponent(permission.id)}` : ""}`, {
      method: permission ? "PUT" : "POST", body: { ...desiredPermission, ...(permission ? { id: permission.id } : {}) },
    });
    listedPermission = await namedPasswordUpdateDocument(api, `${authorization}/permission/scope`, PASSWORD_UPDATE_PERMISSION_NAME);
    if (!listedPermission) throw new Error("Keycloak did not persist the password-update permission");
    permission = await passwordUpdatePermissionDocument(api, `${authorization}/permission/scope`, listedPermission.id);
  }
  if (!permissionReady(permission)) throw new Error("Keycloak did not confirm view/reset-password-only authority");
  await assertPasswordUpdateServiceRoles(api, serviceUser, management);
  if (!passwordUpdateClientReady(client)) {
    if (!apply) return needsRepair();
    await api(path, { method: "PUT", body: { enabled: true } });
    client = await passwordUpdateDocument(api, path);
    if (!passwordUpdateClientReady(client)) throw new Error("Keycloak did not confirm the server-only client configuration");
  }
  log("Password updates: native API configured for the dedicated service account (view and reset-password only)");
  return true;
}

function smtpSettingsFromEnvironment() {
  const host = process.env.KEYCLOAK_SMTP_HOST?.trim();
  const from = process.env.KEYCLOAK_SMTP_FROM?.trim();
  const user = process.env.KEYCLOAK_SMTP_USER?.trim();
  const password = process.env.KEYCLOAK_SMTP_PASSWORD;
  const auth = process.env.KEYCLOAK_SMTP_AUTH?.toLowerCase() === "true";
  if (!host && !from && !user && !password) return null;
  const port = process.env.KEYCLOAK_SMTP_PORT || "587";
  if (!host || !from || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("SMTP setup needs a valid KEYCLOAK_SMTP_HOST, KEYCLOAK_SMTP_FROM, and port");
  if (auth && (!user || !password)) throw new Error("SMTP authentication needs KEYCLOAK_SMTP_USER and KEYCLOAK_SMTP_PASSWORD");
  const starttls = process.env.KEYCLOAK_SMTP_STARTTLS?.toLowerCase() !== "false";
  const ssl = process.env.KEYCLOAK_SMTP_SSL?.toLowerCase() === "true";
  if (starttls && ssl) throw new Error("Use either SMTP STARTTLS or SSL, not both");
  return { host, port, from, fromDisplayName: process.env.KEYCLOAK_SMTP_FROM_DISPLAY_NAME?.trim() || "InOut Management",
    auth: String(auth), ...(auth ? { user, password } : {}), starttls: String(starttls), ssl: String(ssl) };
}

function hasSmtpSender(smtpServer) { return Boolean(smtpServer?.host?.trim() && smtpServer?.from?.trim()); }

export async function configureKeycloakRecovery(api, { apply = false, log = console.log } = {}) {
  const smtpFromEnvironment = smtpSettingsFromEnvironment();
  let realm = await (await api("")).json();
  const recoveryReady = realm.resetPasswordAllowed === true;
  const smtpReady = hasSmtpSender(realm.smtpServer);
  if (!apply) {
    if (!recoveryReady) log("Password recovery: not applied (run with --apply)");
    else log("Password recovery: configured");
    log(`Forgot-password email: ${smtpReady ? "SMTP sender configured" : "SMTP sender not configured"}`);
    return recoveryReady && smtpReady;
  }
  const update = { resetPasswordAllowed: true };
  if (smtpFromEnvironment) update.smtpServer = smtpFromEnvironment;
  await api("", { method: "PUT", body: update });
  realm = await (await api("")).json();
  if (realm.resetPasswordAllowed !== true) throw new Error("Keycloak did not save the password-recovery settings");
  if (smtpFromEnvironment && !hasSmtpSender(realm.smtpServer)) throw new Error("Keycloak did not save the SMTP sender settings");
  log("Password recovery: applied");
  log(`Forgot-password email: ${hasSmtpSender(realm.smtpServer) ? "SMTP sender configured" : "SMTP sender not configured; add SMTP values to .env and rerun this command"}`);
  return true;
}

function requireReady(ready, operation) {
  if (!ready) throw new Error(`${operation} did not pass its verification`);
}

function logMasterAdminStatus(result) {
  console.log(`master-admin realm role: ${result.roleExists ? "present" : "missing"}`);
  console.log(`inherits zone-admin permissions: ${result.zoneAdminComposite ? "configured" : "missing"}`);
  console.log(`frontend token scope: ${result.frontendScope ? "configured" : "missing"}`);
}

export async function prepareKeycloak() {
  const { api, adminBase, base } = await connectLocalKeycloak();
  const providerReady = client => interactionProviderReady(api, adminBase, client);

  console.log("\n> Apply application sign-in settings");
  requireReady(await configureInteractions(api, { apply: true, providerReady }), "Application sign-in apply");
  console.log("\n> Check application sign-in settings");
  requireReady(await configureInteractions(api, { providerReady }), "Application sign-in check");
  console.log("\n> Apply password policy");
  requireReady(await configurePasswordPolicy(api, { apply: true }), "Password policy apply");
  console.log("\n> Check password policy");
  requireReady(await configurePasswordPolicy(api), "Password policy check");
  console.log("\n> Repair account and client scopes");
  requireReady(await repairKeycloakAccountAccess(api, base, { apply: true }), "Account scope repair");
  console.log("\n> Apply master-admin role configuration");
  const appliedMasterAdmin = await configureMasterAdmin(api, { apply: true });
  logMasterAdminStatus(appliedMasterAdmin);
  requireReady(appliedMasterAdmin.ready, "Master-admin role apply");
  console.log("\n> Check master-admin role configuration");
  const checkedMasterAdmin = await configureMasterAdmin(api);
  logMasterAdminStatus(checkedMasterAdmin);
  requireReady(checkedMasterAdmin.ready, "Master-admin role check");
  console.log("\nNo user was granted the master-admin role; assign it only to a designated trusted account in Keycloak.");
  console.log("\nKeycloak setup and checks completed successfully.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { await prepareKeycloak(); return; }
  if (args[0] !== "--action") throw new Error("Usage: npm run keycloak:prepare | node scripts/setup-keycloak.mjs --action <action> --check|--apply");
  const [action, mode, ...extra] = args.slice(1);
  if (!action || !["--check", "--apply"].includes(mode)) throw new Error("Each Keycloak action needs --check or --apply");
  if (extra.length && !(action === "interactions" && extra.length === 1 && extra[0] === "--retire-native-password-client")) {
    throw new Error("Unexpected Keycloak action option");
  }
  const apply = mode === "--apply";
  const { api, adminBase, base } = await connectLocalKeycloak();
  const providerReady = client => interactionProviderReady(api, adminBase, client);
  let ready;
  switch (action) {
    case "app-sign-in": ready = await configureApplicationSignIn(api, { apply, providerReady }); break;
    case "account": ready = await repairKeycloakAccountAccess(api, base, { apply }); break;
    case "interactions": ready = await configureInteractions(api, { apply, providerReady, retireNative: extra.length > 0 }); break;
    case "audit": ready = await configureKeycloakAudit(api, { apply }); break;
    case "invitations": ready = await configureInvitationClient(api, { apply, clientSecret: process.env.KEYCLOAK_INVITE_CLIENT_SECRET }); break;
    case "master-admin": {
      const result = await configureMasterAdmin(api, { apply });
      logMasterAdminStatus(result);
      console.log("No user was granted the master-admin role; assign it only to a designated trusted account in Keycloak.");
      ready = result.ready;
      break;
    }
    case "password-policy": ready = await configurePasswordPolicy(api, { apply }); break;
    case "password-updates": ready = await configurePasswordUpdates(api, { apply, clientSecret: process.env.KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET }); break;
    case "public-urls": ready = await configurePublicApplicationUrls(api, { apply }); break;
    case "recovery": ready = await configureKeycloakRecovery(api, { apply }); break;
    default: throw new Error(`Unknown Keycloak action: ${action}`);
  }
  if (!ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
