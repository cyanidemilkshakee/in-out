import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const groups = {
  frontend: [
    ".test-dist/tests/refreshCoordinator.test.js",
    ".test-dist/tests/contracts.test.js",
    ".test-dist/tests/dateTimeValidation.test.js",
    ".test-dist/tests/buttonWorkflows.test.js",
    ".test-dist/tests/accountWorkflows.test.js",
    ".test-dist/tests/offlineQueue.test.js",
    ".test-dist/tests/analyticsQueries.test.js",
    ".test-dist/tests/reportReadBudget.test.js",
    ".test-dist/tests/requestContext.test.js",
  ],
  auth: [
    ".test-dist/tests/keycloak.test.js",
    ".test-dist/tests/logoutIntent.test.js",
    ".test-dist/tests/securityBoundaries.test.js",
    ".test-dist/tests/authRequestBoundary.test.js",
    ".test-dist/tests/keycloakTokenValidation.test.js",
    ".test-dist/tests/keycloakCredentials.test.js",
    "tests/keycloak-sign-in.test.mjs",
    "tests/keycloak-audit.test.mjs",
    "tests/keycloak-account.test.mjs",
    "tests/keycloak-master-admin.test.mjs",
    "tests/runtimeHealthchecks.test.mjs",
    "tests/passwordActionSignIn.test.mjs",
    ".test-dist/tests/keycloakPasswordUpdate.test.js",
    "tests/keycloak-password-updates.test.mjs",
    "tests/keycloak-interactions.test.mjs",
    "tests/keycloak-password-policy.test.mjs",
  ],
};

const requestedGroup = process.argv[2];
if (!["frontend", "auth", "all"].includes(requestedGroup)) {
  console.error("Usage: node scripts/run-test-group.mjs <frontend|auth|all>");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectedGroups = requestedGroup === "all" ? ["frontend", "auth"] : [requestedGroup];

for (const groupName of selectedGroups) {
  const files = groups[groupName];
  console.log(`\nRunning ${groupName} tests (${files.length} files)`);

  for (const file of files) {
    console.log(`\n→ ${file}`);
    const result = spawnSync(process.execPath, [file], {
      cwd: root,
      stdio: "inherit",
    });

    if (result.error) {
      console.error(`Could not start ${file}: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}
