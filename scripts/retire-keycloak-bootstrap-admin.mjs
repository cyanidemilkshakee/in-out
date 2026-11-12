import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

const environmentPath = fileURLToPath(new URL("../.env", import.meta.url));
const bootstrapKeys = new Set([
  "KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME",
  "KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD",
]);

export async function retireBootstrapAdminSettings() {
  const source = readFileSync(environmentPath, "utf8");
  const hasBootstrapSettings = source.split(/\r?\n/).some((line) =>
    /^\s*KEYCLOAK_BOOTSTRAP_ADMIN_(?:USERNAME|PASSWORD)\s*=/.test(line));
  if (!hasBootstrapSettings) {
    console.log("No separate KEYCLOAK_BOOTSTRAP_ADMIN_* settings are present in .env.");
    console.log("For a legacy .env, KEYCLOAK_ADMIN_USERNAME/PASSWORD held the bootstrap login; replace them with your own admin credentials to remove the old values.");
    return;
  }

  const { adminBase, api, masterApi } = await connectLocalKeycloak({ requireMaintenanceAdmin: true });
  const maintenanceUsername = process.env.KEYCLOAK_ADMIN_USERNAME.trim();
  if (maintenanceUsername === process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim()) {
    throw new Error("Use a different permanent master-realm administrator before retiring the bootstrap account settings.");
  }

  const masterRealm = await (await masterApi("")).json();
  if (masterRealm.realm !== "master") {
    throw new Error("Could not verify master-realm administrator access.");
  }
  await api("/roles");
  console.log(`Verified permanent Keycloak admin access through ${adminBase}.`);

  const updated = source.split(/(?<=\n)/).filter((line) => {
    const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    return !bootstrapKeys.has(key) &&
      line.trim() !== "# Temporary Keycloak master-realm bootstrap account; only used on first initialization.";
  }).join("");
  if (updated !== source) writeFileSync(environmentPath, updated, { mode: 0o600 });
  console.log("Removed the temporary Keycloak bootstrap settings from .env; all other environment entries were preserved.");
  console.log("This does not delete or disable the temporary bootstrap account inside Keycloak.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  retireBootstrapAdminSettings().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
