import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = path.join(repositoryRoot, ".env");
const npmCli = process.env.npm_execpath;
const requestedOptions = new Set(process.argv.slice(2));
const demoMode = requestedOptions.has("--demo");
const yes = requestedOptions.has("--yes");
const supportedOptions = new Set(["--demo", "--yes"]);
const requiredEnvironmentValues = [
  "POSTGRES_PASSWORD",
  "APP_DB_PASSWORD",
  "MIGRATION_DB_PASSWORD",
  "KEYCLOAK_DB_PASSWORD",
  "TEMPORAL_DB_PASSWORD",
  "REDIS_QUOTA_PASSWORD",
  "REDIS_EVENTS_PASSWORD",
  "REDIS_GATEWAY_PASSWORD",
  "KEYCLOAK_CLIENT_SECRET",
  "KONG_IDENTITY_SECRET",
  "AUTH_SECRET",
];

function run(command, args, { captureOutput = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: captureOutput ? "pipe" : "inherit",
    encoding: captureOutput ? "utf8" : undefined,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }

  return {
    status: result.status ?? 1,
    output: captureOutput ? result.stdout ?? "" : "",
  };
}

function runNpm(scriptName) {
  if (!npmCli) {
    throw new Error("Run this through npm, for example: npm run setup:first-run");
  }
  console.log(`\n> npm run ${scriptName}`);
  run(process.execPath, [npmCli, "run", scriptName]);
}

function parseEnvironmentFile() {
  if (!existsSync(environmentPath)) return {};

  const values = {};
  for (const line of readFileSync(environmentPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function composeProjectName(environment) {
  const configured = process.env.COMPOSE_PROJECT_NAME || environment.COMPOSE_PROJECT_NAME;
  if (configured) return configured;

  const folderName = path.basename(repositoryRoot).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return folderName || "inout";
}

function hasDatabaseVolume(projectName) {
  const byLabels = run("docker", [
    "volume", "ls",
    "--filter", `label=com.docker.compose.project=${projectName}`,
    "--filter", "label=com.docker.compose.volume=pg-primary-data",
    "--format", "{{.Name}}",
  ], { captureOutput: true });
  if (byLabels.output.trim()) return true;

  const expectedName = `${projectName}_pg-primary-data`;
  return run("docker", ["volume", "inspect", expectedName], {
    captureOutput: true,
    allowFailure: true,
  }).status === 0;
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node.js 22.12 or newer is required; found ${process.versions.node}.`);
  }
}

function assertComposeVersion(versionOutput) {
  const match = /(?:^|\s)v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.exec(versionOutput.trim());
  if (!match) {
    throw new Error(`Could not determine Docker Compose version from: ${versionOutput.trim() || "empty output"}. Install Docker Compose 2.24 or newer.`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 24)) {
    throw new Error(`Docker Compose 2.24 or newer is required; found ${match[0].trim()}.`);
  }
}

async function confirmDemoSeed() {
  if (yes) return;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Demo setup replaces InOut application records. Re-run in a terminal to confirm, or add --yes only if replacing those records is intended.");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      "Demo setup replaces existing InOut application records with sample data. Type SEED to continue: ",
    );
    if (answer.trim() !== "SEED") {
      throw new Error("Demo setup cancelled; no environment or application data was changed.");
    }
  } finally {
    prompt.close();
  }
}

function verifyExistingEnvironment(environment) {
  const missing = requiredEnvironmentValues.filter((key) => !environment[key]?.trim());
  const hasMaintenanceAdmin = Boolean(environment.KEYCLOAK_ADMIN_USERNAME?.trim() && environment.KEYCLOAK_ADMIN_PASSWORD?.trim());
  const hasBootstrapAdmin = Boolean(environment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim() && environment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD?.trim());
  if (!hasMaintenanceAdmin && !hasBootstrapAdmin) {
    missing.push("KEYCLOAK_ADMIN_USERNAME/KEYCLOAK_ADMIN_PASSWORD (or the bootstrap admin pair)");
  }
  if (missing.length) {
    throw new Error(
      `This project already has a PostgreSQL data volume, but these required .env values are blank: ${missing.join(", ")}. ` +
      "This setup will not generate replacement credentials for an existing database. Restore the matching .env values, then run it again.",
    );
  }
}

function setEnvironmentEntry(source, key, value) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/(?<=\n)/);
  const lineIndex = lines.findIndex((line) => new RegExp(`^${key}=`).test(line));
  if (lineIndex >= 0) {
    if (lines[lineIndex].slice(key.length + 1).trim()) return source;
    lines[lineIndex] = `${key}=${value}${lines[lineIndex].endsWith("\r\n") ? "\r\n" : lines[lineIndex].endsWith("\n") ? "\n" : ""}`;
    return lines.join("");
  }
  const separator = source && !source.endsWith("\n") ? newline : "";
  return `${source}${separator}${key}=${value}${newline}`;
}

function ensureFreshBootstrapCredentials(environment) {
  let source = readFileSync(environmentPath, "utf8");
  const legacyUsername = environment.KEYCLOAK_ADMIN_USERNAME?.trim();
  const legacyPasswordLine = source.split(/\r?\n/).find((line) => /^KEYCLOAK_ADMIN_PASSWORD=/.test(line));
  const legacyPassword = legacyPasswordLine?.slice("KEYCLOAK_ADMIN_PASSWORD=".length) ?? "";
  const bootstrapUsername = environment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim() || legacyUsername || "setup-admin";
  const bootstrapPassword = environment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD?.trim() || legacyPassword.trim();

  source = setEnvironmentEntry(source, "KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME", bootstrapUsername);
  source = setEnvironmentEntry(source, "KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD", bootstrapPassword);
  writeFileSync(environmentPath, source, { mode: 0o600 });
}

async function main() {
  if ([...requestedOptions].some((option) => !supportedOptions.has(option)) ||
      (yes && !demoMode)) {
    throw new Error("Usage: npm run setup:first-run [-- --demo [--yes]]");
  }

  assertNodeVersion();
  if (!npmCli) throw new Error("Start this command with npm run, not by calling the .mjs file directly.");

  if (demoMode) await confirmDemoSeed();

  console.log("Checking Docker Desktop/Engine and Docker Compose...");
  const composeVersion = run("docker", ["compose", "version", "--short"], { captureOutput: true });
  assertComposeVersion(composeVersion.output);
  const dockerInfo = run("docker", ["info", "--format", "{{.ServerVersion}}"], { captureOutput: true });
  if (!dockerInfo.output.trim()) throw new Error("Docker Engine did not report a server version. Start Docker Desktop/Engine and retry.");

  const environmentExists = existsSync(environmentPath);
  const existingDatabase = hasDatabaseVolume(composeProjectName(parseEnvironmentFile()));

  if (existingDatabase && !environmentExists) {
    throw new Error(
      "This Docker Compose project already has a PostgreSQL volume but no .env file. Restore the original .env first; generating new secrets could disconnect the existing database.",
    );
  }

  if (!environmentExists) {
    console.log("\nCreating .env from .env.example...");
    runNpm("env:init");
  }

  if (existingDatabase) {
    verifyExistingEnvironment(parseEnvironmentFile());
    console.log("\nExisting PostgreSQL volume found; preserving its secrets and syncing only default local URLs.");
    runNpm("env:urls:sync");
  } else {
    console.log("\nNo PostgreSQL volume found; filling blank new-install secrets and syncing local URLs.");
    ensureFreshBootstrapCredentials(parseEnvironmentFile());
    runNpm("env:secrets:generate");
    const freshEnvironment = parseEnvironmentFile();
    if (!freshEnvironment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim() ||
        !freshEnvironment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD?.trim()) {
      throw new Error("A fresh Keycloak database needs KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME and KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD in .env.");
    }
  }

  console.log("\nBuilding and starting the application stack. Database volumes are preserved.");
  run("docker", ["compose", "up", "--build", "-d", "--wait"]);

  runNpm("keycloak:setup");

  if (demoMode) {
    runNpm("seed:demo");
    console.log("\nDemo setup is ready. Demo login credentials are in .local-test-accounts/full-demo-accounts.csv.");
  } else {
    console.log("\nThe app stack is ready at http://app.localhost:1008.");
    console.log("Keycloak administration: http://auth.localhost:1009/admin/master/console/");
    console.log("Create the first app user in the inout realm and assign master-admin. Configure Zoho in Keycloak if you want company sign-in.");
    const environment = parseEnvironmentFile();
    if (environment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME || environment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD) {
      console.log("After creating your own Keycloak master-realm admin, put its credentials in KEYCLOAK_ADMIN_USERNAME/PASSWORD and run npm run keycloak:bootstrap-admin:retire to remove the temporary bootstrap credentials from .env.");
    } else {
      console.log("This existing .env uses the older layout: after creating your own Keycloak master-realm admin, replace KEYCLOAK_ADMIN_USERNAME/PASSWORD with its credentials. This removes the old bootstrap values while keeping maintenance scripts configured.");
    }
  }
}

main().catch((error) => {
  console.error(`\nSetup stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
