// Enforce baseline strength without weakening an existing realm policy.
// Apply after rebuilding Keycloak with the bundled password denylist.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const APP_PASSWORD_POLICY = "length(12) and notUsername(undefined) and notEmail(undefined) and passwordBlacklist(inout-common-passwords.txt)";

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
    // Keep an administrator's existing denylist; Keycloak has one policy per
    // provider ID. Never replace it with this smaller baseline list.
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
  if (updated.passwordPolicy !== required) {
    throw new Error("Keycloak did not persist the required password policy");
  }
  log("Password policy: baseline strength applied; existing requirements preserved");
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
