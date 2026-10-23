// Repair the existing local realm without reimporting it or replacing users.
// Read credentials from the project's ignored .env; never print tokens/secrets.
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const selfServiceRoles = ["manage-account", "view-profile"];
const applicationRoles = ["admin", "operator"];
const delegatedAdminRoles = ["manage-users", "query-users", "view-users", "view-realm"];

export function localKeycloakRequest(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "auth.localhost" || target.username || target.password) {
    throw new Error("Local Keycloak credentials must stay on the configured auth.localhost origin");
  }
  // Browsers resolve *.localhost automatically; Node/Windows DNS may not.
  // Connect to loopback while retaining Keycloak's configured Host/origin.
  const headers = new Headers(init.headers);
  headers.set("Host", target.host);
  target.hostname = "127.0.0.1";
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
  if (roles.includes("admin")) {
    for (const name of delegatedAdminRoles) {
      if (!token.resource_access?.["realm-management"]?.roles?.includes(name)) missing.push(`realm-management:${name}`);
    }
  }
  return missing;
}

export async function connectLocalKeycloak() {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const port = process.env.KEYCLOAK_PORT || "1005";
  const adminPort = process.env.KEYCLOAK_ADMIN_PORT || "1009";
  for (const [name, value] of [["KEYCLOAK_PORT", port], ["KEYCLOAK_ADMIN_PORT", adminPort]]) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid local ${name}`);
  }
  if (!process.env.KEYCLOAK_ADMIN_PASSWORD) throw new Error("Set KEYCLOAK_ADMIN_PASSWORD in .env or the environment");
  // OIDC flows use the configured public hostname. Administrative commands
  // use only the temporary loopback listener, enabled by the operator.
  const base = `http://auth.localhost:${port}`;
  const adminBase = `http://auth.localhost:${adminPort}`;
  const login = await localKeycloakRequest(`${adminBase}/realms/master/protocol/openid-connect/token`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli",
      username: process.env.KEYCLOAK_ADMIN_USERNAME || "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`Local administrator authentication failed (HTTP ${login.status})`);
  const { access_token } = await login.json();
  const api = async (path, { method = "GET", body } = {}) => {
    const response = await localKeycloakRequest(`${adminBase}/admin/realms/inout${path}`, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Keycloak ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`);
    return response;
  };
  return { base, api };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some((arg) => !["--apply", "--check"].includes(arg))) {
    throw new Error("Usage: node scripts/keycloak-account-access.mjs [--check|--apply]");
  }
  const { api } = await connectLocalKeycloak();
  const get = async (path) => (await api(path)).json();
  const [account] = await get("/clients?clientId=account");
  const [consoleClient] = await get("/clients?clientId=account-console");
  const [frontend] = await get("/clients?clientId=inout-frontend");
  const [postman] = await get("/clients?clientId=inout-postman");
  if (!account?.enabled || !consoleClient?.enabled) throw new Error("The built-in account and account-console clients must be enabled");
  if (!frontend?.enabled) throw new Error("The inout-frontend client must be enabled");
  const audienceMapper = missingApiAudienceMapper(frontend.protocolMappers || []);
  const scopePlans = await prepareApplicationClientScopes(api, [frontend, ...(postman ? [postman] : [])]);
  const accountRoles = await get(`/clients/${account.id}/roles`);
  // Prepare all additions before any mutation. Preserve role composites and
  // user assignments; only missing built-in account children are added.
  const plans = [];
  for (const name of ["admin", "operator"]) {
    const existing = await get(`/roles/${name}/composites`);
    plans.push({ name, missing: missingAccountRoles(existing, accountRoles, account.id) });
  }
  console.log(`inout-frontend: API audience mapper ${audienceMapper ? "missing" : "present"}`);
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
  let missingFrontendClaims = 0;
  // Verify the tokens Keycloak would issue, without emitting user identities
  // or issuing user sessions. Existing users inherit the role composites.
  for (let first = 0; ; first += 100) {
    const users = await get(`/users?first=${first}&max=100`);
    for (const user of users) {
      const roles = await get(`/users/${user.id}/role-mappings/realm/composite`);
      if (!roles.some((role) => ["admin", "operator"].includes(role.name))) continue;
      const query = new URLSearchParams({ userId: user.id, scope: "openid" });
      const token = await get(`/clients/${consoleClient.id}/evaluate-scopes/generate-example-access-token?${query}`);
      checked++;
      if (![token.aud].flat().includes("account")) missingAudience++;
      if (!token.resource_access?.account?.roles?.includes("manage-account")) missingPermission++;
      const frontendToken = await get(`/clients/${frontend.id}/evaluate-scopes/generate-example-access-token?${query}`);
      if (![frontendToken.aud].flat().includes(process.env.KEYCLOAK_AUDIENCE || "inout-frontend")) missingApiAudience++;
      if (missingFrontendRoleClaims(frontendToken, roles.map((role) => role.name)).length) missingFrontendClaims++;
    }
    if (users.length < 100) break;
  }
  console.log(JSON.stringify({ applicationUsersChecked: checked, missingAccountAudience: missingAudience, missingManageAccount: missingPermission, missingApiAudience, missingFrontendClaims }));
  if (missingAudience || missingPermission || missingApiAudience || missingFrontendClaims ||
    (!apply && (audienceMapper || plans.some((plan) => plan.missing.length) ||
      scopePlans.some((plan) => plan.missing.length || plan.client.fullScopeAllowed !== false)))) {
    if (apply) throw new Error("Tokens still lack required claims; inspect client scopes, mappers, and KEYCLOAK_AUDIENCE");
    console.log("Run with --apply to repair account permissions, API audience, and explicit application role scopes.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
