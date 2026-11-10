import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Run this script with `npm run keycloak:setup`.");
  process.exit(1);
}

const steps = [
  { label: "npm run keycloak:interactions:apply", npmScript: "keycloak:interactions:apply" },
  { label: "npm run keycloak:interactions:check", npmScript: "keycloak:interactions:check" },
  { label: "node scripts/configure-keycloak-password-policy.mjs --apply", nodeScript: "scripts/configure-keycloak-password-policy.mjs", args: ["--apply"] },
  { label: "node scripts/configure-keycloak-password-policy.mjs --check", nodeScript: "scripts/configure-keycloak-password-policy.mjs", args: ["--check"] },
  { label: "npm run keycloak:account:repair", npmScript: "keycloak:account:repair" },
  { label: "npm run keycloak:master-admin:apply", npmScript: "keycloak:master-admin:apply" },
  { label: "npm run keycloak:master-admin:check", npmScript: "keycloak:master-admin:check" },
];

for (const step of steps) {
  console.log(`\n> ${step.label}`);
  const args = step.npmScript
    ? [npmCli, "run", step.npmScript]
    : [path.join(repositoryRoot, step.nodeScript), ...step.args];
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Could not run ${step.label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nStopped: ${step.label} failed with exit code ${result.status ?? 1}.`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nKeycloak setup and checks completed successfully.");
