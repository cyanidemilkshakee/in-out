// Prepare a local install: install locked Node dependencies, create .env when
// missing, fill blank generated secrets, and synchronize default local URLs.
import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleFile = path.join(repositoryRoot, ".env.example");
const environmentFile = path.join(repositoryRoot, ".env");
const featureSecrets = {
  database: ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "MIGRATION_DB_PASSWORD", "KEYCLOAK_DB_PASSWORD", "TEMPORAL_DB_PASSWORD"],
  redis: ["REDIS_QUOTA_PASSWORD", "REDIS_EVENTS_PASSWORD", "REDIS_GATEWAY_PASSWORD"],
  gateway: ["KONG_IDENTITY_SECRET", "KONG_TERMINAL_SECRET"],
  auth: ["AUTH_SECRET"],
  keycloak: ["KEYCLOAK_CLIENT_SECRET", "KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD", "KEYCLOAK_PASSWORD_UPDATE_CLIENT_SECRET"],
  invitations: ["KEYCLOAK_INVITE_CLIENT_SECRET"],
};

function initializeEnvironmentFile() {
  if (existsSync(environmentFile)) {
    console.log(".env already exists; leaving it unchanged.");
    return;
  }
  copyFileSync(exampleFile, environmentFile, constants.COPYFILE_EXCL);
  console.log("Created .env from .env.example.");
}

function installLockedDependencies() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this through npm: npm run setup:prepare");
  console.log("\n> npm ci");
  const result = spawnSync(process.execPath, [npmCli, "ci"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not run npm ci: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readArguments() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--prepare") return { prepare: true, initOnly: false, urlsOnly: false, feature: "all" };
  if (args.length === 1 && args[0] === "--init-only") return { prepare: false, initOnly: true, urlsOnly: false, feature: "all" };
  if (args.length === 1 && args[0] === "--urls-only") return { prepare: false, initOnly: false, urlsOnly: true, feature: "all" };
  if (args.length === 0) return { prepare: false, initOnly: false, urlsOnly: false, feature: "all" };

  const selected = args.length === 1 ? args[0] : args[0] === "--feature" ? args[1] : undefined;
  if ((args.length !== 1 && args.length !== 2) ||
      (args.length === 2 && args[0] !== "--feature") ||
      (selected !== "all" && !Object.hasOwn(featureSecrets, selected))) {
    throw new Error(`Usage: npm run setup:prepare | npm run env:init | npm run env:urls:sync | npm run env:secrets:generate -- [--feature ${[...Object.keys(featureSecrets), "all"].join("|")}]`);
  }
  return { prepare: false, initOnly: false, urlsOnly: false, feature: selected };
}

function configuredPort(source, key, fallback) {
  const match = source.match(new RegExp(`^${key}=([^\\r\\n]*)\\r?$`, "m"));
  const value = match?.[1].trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${key} must be an integer from 1 to 65535`);
  }
  return String(Number(value));
}

function canSyncLocalUrl(key, value) {
  if (!value.trim()) return true;
  const managedLocalUrls = {
    AUTH_URL: ["app.localhost", "/"],
    INOUT_APP_URL: ["app.localhost", "/"],
    PYTHON_API_URL: ["127.0.0.1", "/"],
    KEYCLOAK_PUBLIC_URL: ["auth.localhost", "/"],
  };
  try {
    const url = new URL(value);
    const [hostname, pathname] = managedLocalUrls[key];
    return url.protocol === "http:" && url.hostname === hostname &&
      url.pathname === pathname && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function generateMissingSecretsAndSyncUrls({ feature, urlsOnly }) {
  const source = await readFile(environmentFile, "utf8");
  const urls = feature === "all" ? {
    AUTH_URL: `http://app.localhost:${configuredPort(source, "APP_PORT", "1008")}`,
    INOUT_APP_URL: `http://app.localhost:${configuredPort(source, "APP_PORT", "1008")}`,
    PYTHON_API_URL: `http://127.0.0.1:${configuredPort(source, "PYTHON_API_PORT", "1002")}`,
    KEYCLOAK_PUBLIC_URL: `http://auth.localhost:${configuredPort(source, "KEYCLOAK_PORT", "1005")}`,
  } : {};
  const secrets = new Set(urlsOnly ? [] : feature === "all" ? Object.values(featureSecrets).flat() : featureSecrets[feature]);
  let filled = 0;
  const filledKeys = [];
  const foundKeys = new Set();
  const foundUrlKeys = new Set();
  const updatedUrlKeys = [];

  let result = source.replace(/^([A-Z][A-Z0-9_]*)=([^\r\n]*)/gm, (line, key, value) => {
    if (secrets.has(key)) {
      foundKeys.add(key);
      if (value.trim()) return line;
      filled++;
      filledKeys.push(key);
      return `${key}=${randomBytes(32).toString("base64url")}`;
    }
    if (!Object.hasOwn(urls, key)) return line;
    foundUrlKeys.add(key);
    if (!canSyncLocalUrl(key, value) || value.trim() === urls[key]) return line;
    updatedUrlKeys.push(key);
    return `${key}=${urls[key]}`;
  });

  const missingKeys = [...secrets].filter(key => !foundKeys.has(key));
  const missingUrlKeys = Object.keys(urls).filter(key => !foundUrlKeys.has(key));
  if (missingKeys.length || missingUrlKeys.length) {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    if (result && !result.endsWith("\n")) result += newline;
    result += [
      ...missingKeys.map(key => `${key}=${randomBytes(32).toString("base64url")}`),
      ...missingUrlKeys.map(key => `${key}=${urls[key]}`),
    ].join(newline);
    filled += missingKeys.length;
    filledKeys.push(...missingKeys);
  }

  if (filled || updatedUrlKeys.length || missingUrlKeys.length) {
    await writeFile(environmentFile, result, { mode: 0o600 });
  }
  console.log(`Filled ${filled} empty secret field(s) for ${feature}: ${filledKeys.join(", ") || "none"}. Secret values are not printed.`);
  if (feature === "all") {
    console.log(`Synchronized ${updatedUrlKeys.length + missingUrlKeys.length} local URL field(s) with configured ports: ${[...updatedUrlKeys, ...missingUrlKeys].join(", ") || "none"}.`);
  }
  if (feature === "all" && !urlsOnly) {
    console.log("Use --feature to scope generation. For an existing installation, do not fill blank database or Keycloak bootstrap secrets unless you have confirmed they match the persisted services.");
  }
  console.log("Provider-issued credentials (such as SMTP passwords) are never generated by this script.");
}

async function main() {
  const options = readArguments();
  if (options.prepare) installLockedDependencies();
  initializeEnvironmentFile();
  if (options.initOnly) return;
  await generateMissingSecretsAndSyncUrls(options);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
