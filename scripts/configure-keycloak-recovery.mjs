// Apply only password recovery and supplied SMTP settings.
// Never prints SMTP credentials or Keycloak access tokens.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

function smtpSettingsFromEnvironment() {
  const host = process.env.KEYCLOAK_SMTP_HOST?.trim();
  const from = process.env.KEYCLOAK_SMTP_FROM?.trim();
  const user = process.env.KEYCLOAK_SMTP_USER?.trim();
  const password = process.env.KEYCLOAK_SMTP_PASSWORD;
  const auth = process.env.KEYCLOAK_SMTP_AUTH?.toLowerCase() === "true";
  const configured = Boolean(host || from || user || password);
  if (!configured) return null;

  const port = process.env.KEYCLOAK_SMTP_PORT || "587";
  if (!host || !from || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("SMTP setup needs a valid KEYCLOAK_SMTP_HOST, KEYCLOAK_SMTP_FROM, and port");
  }
  if (auth && (!user || !password)) {
    throw new Error("SMTP authentication needs KEYCLOAK_SMTP_USER and KEYCLOAK_SMTP_PASSWORD");
  }

  const starttls = process.env.KEYCLOAK_SMTP_STARTTLS?.toLowerCase() !== "false";
  const ssl = process.env.KEYCLOAK_SMTP_SSL?.toLowerCase() === "true";
  if (starttls && ssl) throw new Error("Use either SMTP STARTTLS or SSL, not both");

  return {
    host,
    port,
    from,
    fromDisplayName: process.env.KEYCLOAK_SMTP_FROM_DISPLAY_NAME?.trim() || "InOut Management",
    auth: String(auth),
    ...(auth ? { user, password } : {}),
    starttls: String(starttls),
    ssl: String(ssl),
  };
}

function hasSmtpSender(smtpServer) {
  return Boolean(smtpServer?.host?.trim() && smtpServer?.from?.trim());
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-recovery.mjs --check|--apply");
  }
  const apply = mode === "--apply";
  const { api } = await connectLocalKeycloak();
  const desired = { resetPasswordAllowed: true };
  const smtpFromEnvironment = smtpSettingsFromEnvironment();
  let realm = await (await api("")).json();
  const recoveryReady = realm.resetPasswordAllowed === true;
  const smtpReady = hasSmtpSender(realm.smtpServer);

  if (!recoveryReady && !apply) {
    console.log("Password recovery: not applied (run with --apply)");
  }
  if (!apply) {
    if (recoveryReady) console.log("Password recovery: configured");
    console.log(`Forgot-password email: ${smtpReady ? "SMTP sender configured" : "SMTP sender not configured"}`);
    if (!recoveryReady || !smtpReady) process.exitCode = 1;
    return;
  }

  const update = { ...desired };
  if (smtpFromEnvironment) update.smtpServer = smtpFromEnvironment;
  await api("", { method: "PUT", body: update });
  realm = await (await api("")).json();
  if (realm.resetPasswordAllowed !== true) {
    throw new Error("Keycloak did not save the password-recovery settings");
  }
  if (smtpFromEnvironment && !hasSmtpSender(realm.smtpServer)) {
    throw new Error("Keycloak did not save the SMTP sender settings");
  }

  console.log("Password recovery: applied");
  console.log(`Forgot-password email: ${hasSmtpSender(realm.smtpServer) ? "SMTP sender configured" : "SMTP sender not configured; add SMTP values to .env and rerun this command"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
