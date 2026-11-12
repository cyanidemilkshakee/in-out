// Repair the existing local realm without reimporting it or replacing users.
// Read credentials from the project's ignored .env; never print tokens/secrets.
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const selfServiceRoles = ["manage-account", "view-profile"];
const applicationRoles = ["zone-admin", "operator"];
const delegatedAdminRoles = ["manage-users", "query-users", "view-users", "view-realm"];

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
    try { target = new URL(value); } catch { throw new Error("Local Keycloak credentials must stay on the configured auth.localhost origin or an explicitly configured HTTPS origin"); }
    const localConsolePath = target.hostname === "auth.localhost" && target.pathname === "/admin/master/console/";
    if (!(["http:", "https:"].includes(target.protocol) && target.hostname &&
        !target.username && !target.password && (["", "/"].includes(target.pathname) || localConsolePath) && !target.search && !target.hash &&
        (target.protocol === "https:" || target.hostname === "auth.localhost"))) {
      throw new Error("Local Keycloak credentials must stay on the configured auth.localhost origin or an explicitly configured HTTPS origin");
    }
    return target.origin;
  }));
}

export function localKeycloakRequest(url, init = {}) {
  const target = new URL(url);
  if (target.username || target.password || target.hash || !configuredKeycloakOrigins().has(target.origin) ||
      (target.protocol === "http:" && target.hostname !== "auth.localhost")) {
    throw new Error("Local Keycloak credentials must stay on the configured auth.localhost origin or an explicitly configured HTTPS origin");
  }
  const headers = new Headers(init.headers);
  headers.delete("Host");
  if (target.protocol === "http:") {
    // Browsers resolve *.localhost automatically; Node/Windows DNS may not.
    // Connect to loopback while retaining Keycloak's configured Host/origin.
    headers.set("Host", target.host);
    target.hostname = "127.0.0.1";
  }
  return fetch(target, { ...init, headers, redirect: "manual" });
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
  if (!await hasDefaultAdminApiScope(api, clientId, scope)) {
    throw new Error("Keycloak did not confirm the kc-admin-api default scope assignment");
  }
  return true;
}

export function missingAccountRoles(existing, accountRoles, accountClientId) {
  const required = selfServiceRoles.map((name) => {
    const role = accountRoles.find((candidate) => candidate.name === name &&
      candidate.clientRole === true && candidate.containerId === accountClientId);
    if (!role?.id) throw new Error(`Missing built-in account role: ${name}`);
    return role;
  });
  return required.filter((role) => !existing.some((candidate) => candidate.id === role.id));
}

export function missingApplicationScopeRoles(existing, realmRoles) {
  const required = applicationRoles.map((name) => {
    const role = realmRoles.find((candidate) => candidate.name === name && candidate.clientRole === false);
    if (!role?.id) throw new Error(`Missing application realm role: ${name}`);
    return role;
  });
  return required.filter((role) => !existing.some((candidate) => candidate.id === role.id));
}

export async function prepareApplicationClientScopes(api, clients) {
  const get = async (path) => (await api(path)).json();
  const realmRoles = [];
  for (const name of applicationRoles) realmRoles.push(await get(`/roles/${name}`));
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
  // Install and verify every mapping before disabling unrestricted scope.
  // Mapping a composite role includes its account/delegated administration
  // children only for users who actually hold that application role.
  for (const { client, realmRoles, missing } of plans) {
    if (missing.length) {
      await api(`/clients/${client.id}/scope-mappings/realm`, { method: "POST", body: missing });
    }
    const existing = await (await api(`/clients/${client.id}/scope-mappings/realm`)).json();
    if (missingApplicationScopeRoles(existing, realmRoles).length) {
      throw new Error(`Application scope mapping repair failed for ${client.clientId}`);
    }
  }
  for (const { client } of plans) {
    if (client.fullScopeAllowed !== false) {
      // A partial update avoids replacing secrets, origins, mappers, or other
      // configuration edited concurrently by the administrator.
      await api(`/clients/${client.id}`, { method: "PUT", body: { fullScopeAllowed: false } });
    }
    const updated = await (await api(`/clients/${client.id}`)).json();
    if (updated.fullScopeAllowed !== false) throw new Error(`Full scope remains enabled for ${client.clientId}`);
  }
}

export function missingFrontendRoleClaims(token, userRoleNames) {
  const missing = [];
  const roles = applicationRoles.filter((name) => userRoleNames.includes(name));
  for (const name of roles) {
    if (!token.realm_access?.roles?.includes(name)) missing.push(`realm:${name}`);
  }
  if (roles.length) {
    for (const name of selfServiceRoles) {
      if (!token.resource_access?.account?.roles?.includes(name)) missing.push(`account:${name}`);
    }
  }
  if (roles.includes("zone-admin")) {
    for (const name of delegatedAdminRoles) {
      if (!token.resource_access?.["realm-management"]?.roles?.includes(name)) missing.push(`realm-management:${name}`);
    }
  }
  return missing;
}

export async function connectLocalKeycloak({ requireMaintenanceAdmin = false } = {}) {
  loadProjectEnvironment();
  const port = process.env.KEYCLOAK_PORT || "1005";
  const adminPort = process.env.KEYCLOAK_ADMIN_PORT || "1009";
  for (const [name, value] of [["KEYCLOAK_PORT", port], ["KEYCLOAK_ADMIN_PORT", adminPort]]) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid local ${name}`);
  }
  const hasMaintenanceAdmin = Boolean(process.env.KEYCLOAK_ADMIN_USERNAME?.trim() && process.env.KEYCLOAK_ADMIN_PASSWORD?.trim());
  if (requireMaintenanceAdmin && !hasMaintenanceAdmin) {
    throw new Error("Set KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD to your permanent Keycloak master-realm admin before retiring bootstrap credentials");
  }
  const adminUsername = hasMaintenanceAdmin
    ? process.env.KEYCLOAK_ADMIN_USERNAME
    : process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME || "admin";
  const adminPassword = hasMaintenanceAdmin
    ? process.env.KEYCLOAK_ADMIN_PASSWORD
    : process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("Set the permanent Keycloak admin pair or the temporary bootstrap admin pair in .env");
  // OIDC calls use the public issuer, while administrative API calls use the
  // explicitly configured private maintenance origin (loopback by default).
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
  return { base, adminBase, api: createRealmApi("inout"), masterApi: createRealmApi("master") };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((arg) => !["--apply", "--check"].includes(arg))) {
    throw new Error("Usage: node scripts/keycloak-account-access.mjs [--check|--apply]");
  }
  const { api, base } = await connectLocalKeycloak();
  const expectedAdminApiAudience = `${base.replace(/\/+$/, "")}/admin/realms/inout`;
  const get = async (path) => (await api(path)).json();
  const [account] = await get("/clients?clientId=account");
  const [consoleClient] = await get("/clients?clientId=account-console");
  const [frontend] = await get("/clients?clientId=inout-frontend");
  const [postman] = await get("/clients?clientId=inout-postman");
  if (!account?.enabled || !consoleClient?.enabled) throw new Error("The built-in account and account-console clients must be enabled");
  if (!frontend?.enabled) throw new Error("The inout-frontend client must be enabled");
  const adminApiScopes = (await get("/client-scopes")).filter((scope) => scope?.name === "kc-admin-api");
  if (adminApiScopes.length !== 1 || !adminApiScopes[0]?.id) {
    throw new Error("Keycloak must provide exactly one built-in kc-admin-api client scope (Keycloak 26.8 or newer)");
  }
  const adminApiScope = adminApiScopes[0];
  let hasAdminApiScope = await hasDefaultAdminApiScope(api, frontend.id, adminApiScope);
  const audienceMapper = missingApiAudienceMapper(frontend.protocolMappers || []);
  const scopePlans = await prepareApplicationClientScopes(api, [frontend, ...(postman ? [postman] : [])]);
  const accountRoles = await get(`/clients/${account.id}/roles`);
  // Prepare all additions before any mutation. Preserve role composites and
  // user assignments; only missing built-in account children are added.
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
  // Verify the tokens Keycloak would issue, without emitting user identities
  // or issuing user sessions. Existing users inherit the role composites.
  for (let first = 0; ; first += 100) {
    const users = await get(`/users?first=${first}&max=100`);
    for (const user of users) {
      const roles = await get(`/users/${user.id}/role-mappings/realm/composite`);
      if (!roles.some((role) => ["zone-admin", "operator"].includes(role.name))) continue;
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
  if (missingAudience || missingPermission || missingApiAudience || missingAdminApiAudience || missingAdminApiScope || missingFrontendClaims ||
    (!apply && (!hasAdminApiScope || audienceMapper || plans.some((plan) => plan.missing.length) ||
      scopePlans.some((plan) => plan.missing.length || plan.client.fullScopeAllowed !== false)))) {
    if (apply) throw new Error("Tokens still lack required claims; inspect client scopes, mappers, and KEYCLOAK_AUDIENCE");
    console.log("Run with --apply to repair account permissions, API audiences and scope, and explicit application role scopes.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
