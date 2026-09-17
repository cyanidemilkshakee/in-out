// Repair the existing local realm without reimporting it or replacing users.
// Read credentials from the project's ignored .env; never print tokens/secrets.
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const selfServiceRoles = ["manage-account", "view-profile"];

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

export async function connectLocalKeycloak() {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const port = process.env.KEYCLOAK_PORT || "1005";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid local KEYCLOAK_PORT");
  if (!process.env.KEYCLOAK_ADMIN_PASSWORD) throw new Error("Set KEYCLOAK_ADMIN_PASSWORD in .env or the environment");
  const base = `http://localhost:${port}`;
  const login = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli",
      username: process.env.KEYCLOAK_ADMIN_USERNAME || "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`Local administrator authentication failed (HTTP ${login.status})`);
  const { access_token } = await login.json();
  const api = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}/admin/realms/inout${path}`, {
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
  if (!account?.enabled || !consoleClient?.enabled) throw new Error("The built-in account and account-console clients must be enabled");
  if (!frontend?.enabled) throw new Error("The inout-frontend client must be enabled");
  const audienceMapper = missingApiAudienceMapper(frontend.protocolMappers || []);
  const accountRoles = await get(`/clients/${account.id}/roles`);
  // Prepare both additions before any mutation. Only built-in self-service
  // roles are eligible; no realm-management privileges or user assignments.
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

  let checked = 0;
  let missingAudience = 0;
  let missingPermission = 0;
  let missingApiAudience = 0;
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
    }
    if (users.length < 100) break;
  }
  console.log(JSON.stringify({ applicationUsersChecked: checked, missingAccountAudience: missingAudience, missingManageAccount: missingPermission, missingApiAudience }));
  if (missingAudience || missingPermission || missingApiAudience ||
    (!apply && (audienceMapper || plans.some((plan) => plan.missing.length)))) {
    if (apply) throw new Error("Tokens still lack required claims; inspect client scopes, mappers, and KEYCLOAK_AUDIENCE");
    console.log("Run with --apply to add missing self-service role composites and the API audience mapper.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
