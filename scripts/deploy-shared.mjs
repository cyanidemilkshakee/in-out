import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isIPv4 } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFiles = ["compose", "-f", "compose.yaml", "-f", "compose.shared.yaml"];
const envFile = path.join(root, ".env");
if (!existsSync(envFile)) throw new Error(".env is missing. Copy .env.example to .env and configure the public HTTPS hostnames first.");
process.loadEnvFile(envFile);

function publicDomain(name) {
  const value = process.env[name]?.trim();
  if (!value || value.length > 253 || value.endsWith(".localhost") || value === "localhost" ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) {
    throw new Error(`${name} must be a public DNS hostname that you control, not a .localhost name or IP address.`);
  }
  return value.toLowerCase();
}

function httpsOrigin(name) {
  const value = process.env[name]?.trim();
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a complete HTTPS origin.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || (url.port && url.port !== "443")) {
    throw new Error(`${name} must be an HTTPS origin on port 443 with no path, credentials, query or fragment.`);
  }
  return url;
}

const appHost = publicDomain("APP_PUBLIC_HOSTNAME");
const identityHost = publicDomain("KEYCLOAK_PUBLIC_HOSTNAME");
const appOrigin = httpsOrigin("AUTH_URL");
const identityOrigin = httpsOrigin("KEYCLOAK_PUBLIC_URL");
if (appHost === identityHost) throw new Error("APP_PUBLIC_HOSTNAME and KEYCLOAK_PUBLIC_HOSTNAME must be different hostnames.");
if (appOrigin.hostname.toLowerCase() !== appHost || identityOrigin.hostname.toLowerCase() !== identityHost) {
  throw new Error("AUTH_URL and KEYCLOAK_PUBLIC_URL hostnames must match their corresponding *_PUBLIC_HOSTNAME values.");
}

function ipv4Integer(value, name) {
  if (!isIPv4(value)) throw new Error(`${name} must be an IPv4 address.`);
  return value.split(".").reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
}
const ingressSubnet = (process.env.SHARED_INGRESS_SUBNET || "172.30.250.0/29").trim();
const subnetMatch = ingressSubnet.match(/^(.+)\/(\d{1,2})$/);
if (!subnetMatch) throw new Error("SHARED_INGRESS_SUBNET must use IPv4 CIDR notation.");
const subnetAddress = ipv4Integer(subnetMatch[1], "SHARED_INGRESS_SUBNET");
const prefix = Number(subnetMatch[2]);
if (prefix < 16 || prefix > 29) throw new Error("SHARED_INGRESS_SUBNET prefix must be between /16 and /29.");
const blockSize = 1n << BigInt(32 - prefix);
const networkAddress = subnetAddress - (subnetAddress % blockSize);
if (networkAddress !== subnetAddress) throw new Error("SHARED_INGRESS_SUBNET must be aligned to its CIDR boundary.");
const caddyAddress = ipv4Integer(process.env.SHARED_CADDY_IP || "172.30.250.2", "SHARED_CADDY_IP");
if (caddyAddress <= networkAddress + 1n || caddyAddress >= networkAddress + blockSize - 1n) {
  throw new Error("SHARED_CADDY_IP must be a usable host address in SHARED_INGRESS_SUBNET (not its gateway, network or broadcast address).");
}

const adminUrl = process.env.KEYCLOAK_ADMIN_ORIGIN?.trim();
if (adminUrl) {
  let parsed;
  try { parsed = new URL(adminUrl); } catch { throw new Error("KEYCLOAK_ADMIN_ORIGIN must be a private HTTPS origin or the local auth.localhost URL."); }
  const localAdmin = parsed.protocol === "http:" && parsed.hostname === "auth.localhost" &&
    !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  const remoteAdmin = parsed.protocol === "https:" && !parsed.username && !parsed.password &&
    parsed.pathname === "/" && !parsed.search && !parsed.hash && (!parsed.port || parsed.port === "443");
  if (!localAdmin && !remoteAdmin) {
    throw new Error("KEYCLOAK_ADMIN_ORIGIN must be a private HTTPS origin or the local auth.localhost URL.");
  }
}

const hasBootstrapAdmin = Boolean(process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME?.trim() && process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD?.trim());
if (!hasBootstrapAdmin) {
  throw new Error("Set KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME and KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD in .env before shared deployment.");
}

function run(label, command, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 1}; public HTTPS access was not enabled.`);
}

console.log("Starting the shared profile. Caddy will publish ports 80 and 443 for the configured HTTPS hostnames.");
console.log("Make sure both DNS records point to this server and the firewall permits inbound TCP 80/443 (and UDP 443 for HTTP/3).");
console.log("The app and Keycloak callback settings are repaired before Caddy is opened to public traffic.");
const currentCaddy = spawnSync("docker", [...composeFiles, "--profile", "shared", "ps", "-q", "caddy"], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
});
if (currentCaddy.error) throw currentCaddy.error;
if (currentCaddy.status !== 0) throw new Error("Could not inspect the current Caddy service; shared deployment was stopped.");
if (currentCaddy.stdout.trim()) run("stop the existing public proxy during the update", "docker",
  [...composeFiles, "--profile", "shared", "stop", "caddy"]);
try {
  run("build and start the private application stack", "docker", [...composeFiles, "up", "--build", "-d", "--wait"]);
  run("assign and verify the Keycloak Admin REST scope used for delegated user management", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "account", "--apply"]);
  run("verify delegated account and Admin REST token scopes", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "account", "--check"]);
  run("register the HTTPS application callbacks and logout URLs", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "public-urls", "--apply"]);
  run("configure and verify the app-managed Keycloak sign-in", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "app-sign-in", "--apply"]);
  run("verify the registered HTTPS application callbacks", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "public-urls", "--check"]);
  run("verify the app-managed Keycloak sign-in", process.execPath,
    [path.join(root, "scripts/setup-keycloak.mjs"), "--action", "app-sign-in", "--check"]);
} catch (error) {
  try { run("close the loopback-only Keycloak maintenance gateway", "docker", [...composeFiles, "stop", "keycloak-admin"]); }
  catch (stopError) { console.error(`Could not stop the maintenance gateway after failure: ${stopError.message}`); }
  throw error;
}
run("close the loopback-only Keycloak maintenance gateway", "docker",
  [...composeFiles, "stop", "keycloak-admin"]);
run("enable the public HTTPS proxy", "docker", [...composeFiles, "--profile", "shared", "up", "-d", "--wait", "caddy"]);
console.log(`\nShared HTTPS deployment is ready at ${appOrigin.origin} (identity: ${identityOrigin.origin}).`);
