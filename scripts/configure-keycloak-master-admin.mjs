// Provision the privileged application role and its frontend token scope.
// This intentionally never assigns the role to a user or changes client grants.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

const hasRole = (roles, expected) => roles.some((role) =>
  (expected.id && role.id === expected.id) || role.name === expected.name);

export async function configureMasterAdmin(api, { apply = false } = {}) {
  const get = async (path) => (await api(path)).json();
  let realmRoles = await get("/roles");
  const adminRole = realmRoles.find((role) => role.name === "admin");
  if (!adminRole?.id) throw new Error("The InOut admin realm role is missing");
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

  let composites = masterRole?.id
    ? await get(`/roles/${encodeURIComponent(masterRole.name)}/composites`)
    : [];
  let scopeRoles = await get(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`);
  let needsAdminComposite = Boolean(masterRole && !hasRole(composites, adminRole));
  let needsFrontendScope = Boolean(masterRole && !hasRole(scopeRoles, masterRole));

  if (apply && masterRole && needsAdminComposite) {
    await api(`/roles/${encodeURIComponent(masterRole.name)}/composites`, {
      method: "POST", body: [adminRole],
    });
    composites = await get(`/roles/${encodeURIComponent(masterRole.name)}/composites`);
    needsAdminComposite = !hasRole(composites, adminRole);
    if (needsAdminComposite) throw new Error("Keycloak did not add admin as a master-admin composite");
  }
  if (apply && masterRole && needsFrontendScope) {
    await api(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`, {
      method: "POST", body: [masterRole],
    });
    scopeRoles = await get(`/clients/${encodeURIComponent(frontend.id)}/scope-mappings/realm`);
    needsFrontendScope = !hasRole(scopeRoles, masterRole);
    if (needsFrontendScope) throw new Error("Keycloak did not expose master-admin in frontend tokens");
  }

  const ready = Boolean(masterRole && !needsAdminComposite && !needsFrontendScope);
  return {
    ready,
    roleExists: Boolean(masterRole),
    adminComposite: Boolean(masterRole) && !needsAdminComposite,
    frontendScope: Boolean(masterRole) && !needsFrontendScope,
  };
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-master-admin.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  const result = await configureMasterAdmin(api, { apply: mode === "--apply" });
  console.log(`master-admin realm role: ${result.roleExists ? "present" : "missing"}`);
  console.log(`inherits admin permissions: ${result.adminComposite ? "configured" : "missing"}`);
  console.log(`frontend token scope: ${result.frontendScope ? "configured" : "missing"}`);
  console.log("No user was granted the master-admin role; assign it only to a designated trusted account in Keycloak.");
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
