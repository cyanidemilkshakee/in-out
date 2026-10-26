// Align the existing realm's password policy with app-side validation.
// The partial realm update preserves users, clients, and all other settings.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const APP_PASSWORD_POLICY = "length(8) and maxLength(128) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and notEmail";

export async function configurePasswordPolicy(api, { apply = false, log = console.log } = {}) {
  const realm = await (await api("")).json();
  if (realm.passwordPolicy === APP_PASSWORD_POLICY) {
    log("Password policy: configured");
    return true;
  }
  if (!apply) {
    log("Password policy: needs update (run with --apply)");
    return false;
  }
  await api("", { method: "PUT", body: { passwordPolicy: APP_PASSWORD_POLICY } });
  const updated = await (await api("")).json();
  if (updated.passwordPolicy !== APP_PASSWORD_POLICY) {
    throw new Error("Keycloak did not save the password policy");
  }
  log("Password policy: applied");
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
