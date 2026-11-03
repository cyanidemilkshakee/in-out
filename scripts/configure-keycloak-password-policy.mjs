// Clear password-strength rules from an existing realm.
// The partial realm update preserves users, clients, and all other settings.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const APP_PASSWORD_POLICY = "";

export async function configurePasswordPolicy(api, { apply = false, log = console.log } = {}) {
  const realm = await (await api("")).json();
  if (typeof realm.passwordPolicy !== "string" || !realm.passwordPolicy.trim()) {
    log("Password policy: no requirements");
    return true;
  }
  if (!apply) {
    log("Password policy: needs update (run with --apply)");
    return false;
  }
  await api("", { method: "PUT", body: { passwordPolicy: APP_PASSWORD_POLICY } });
  const updated = await (await api("")).json();
  if (typeof updated.passwordPolicy === "string" && updated.passwordPolicy.trim()) {
    throw new Error("Keycloak did not clear the password policy");
  }
  log("Password policy: cleared");
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-password-policy.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configurePasswordPolicy(api, { apply: mode === "--apply" })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
