// Enable bounded Keycloak login and administrator audit-event retention.
// This updates realm event settings only; it never edits clients or grants.
import { pathToFileURL } from "node:url";
import { connectLocalKeycloak } from "./keycloak-account-access.mjs";

export const EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const REQUIRED_USER_EVENT_TYPES = [
  "LOGIN",
  "LOGIN_ERROR",
  "LOGOUT",
  "CODE_TO_TOKEN",
  "CODE_TO_TOKEN_ERROR",
  "REFRESH_TOKEN_ERROR",
  "UPDATE_PASSWORD",
  "UPDATE_PASSWORD_ERROR",
  "RESET_PASSWORD",
  "RESET_PASSWORD_ERROR",
  "UPDATE_TOTP",
  "UPDATE_TOTP_ERROR",
  "REMOVE_TOTP",
  "REMOVE_TOTP_ERROR",
];

export function keycloakAuditSettings(realm) {
  const currentTypes = Array.isArray(realm.enabledEventTypes) ? realm.enabledEventTypes : [];
  // In Keycloak, an empty list means all event types. Preserve that broader
  // existing choice instead of narrowing an administrator's audit selection.
  const eventTypes = realm.eventsEnabled === true && currentTypes.length === 0
    ? []
    : [...new Set([...currentTypes, ...REQUIRED_USER_EVENT_TYPES])].sort();
  const currentRetention = Number.isFinite(realm.eventsExpiration) ? realm.eventsExpiration : 0;
  const currentAdminRetention = Number(realm.attributes?.adminEventsExpiration) || 0;
  const adminEventsExpiration = Math.max(currentAdminRetention, EVENT_RETENTION_SECONDS);

  return {
    eventsEnabled: true,
    eventsExpiration: Math.max(currentRetention, EVENT_RETENTION_SECONDS),
    enabledEventTypes: eventTypes,
    adminEventsEnabled: true,
    // Avoid storing full request representations, which can contain personal
    // data or other sensitive values. Operation/resource metadata is retained.
    adminEventsDetailsEnabled: false,
    attributes: {
      ...(realm.attributes || {}),
      adminEventsExpiration: String(adminEventsExpiration),
    },
  };
}

export function keycloakAuditReady(realm) {
  const types = Array.isArray(realm.enabledEventTypes) ? realm.enabledEventTypes : [];
  const allTypesEnabled = realm.eventsEnabled === true && types.length === 0;
  return realm.eventsEnabled === true &&
    Number(realm.eventsExpiration) >= EVENT_RETENTION_SECONDS &&
    Number(realm.attributes?.adminEventsExpiration) >= EVENT_RETENTION_SECONDS &&
    (allTypesEnabled || REQUIRED_USER_EVENT_TYPES.every((type) => types.includes(type))) &&
    realm.adminEventsEnabled === true &&
    realm.adminEventsDetailsEnabled !== true;
}

export async function configureKeycloakAudit(api, { apply = false, log = console.log } = {}) {
  let realm = await (await api("")).json();
  if (keycloakAuditReady(realm)) {
    log("Keycloak event auditing: configured with bounded retention");
    return true;
  }
  if (!apply) {
    log("Keycloak event auditing: needs configuration (run with --apply)");
    return false;
  }

  await api("", { method: "PUT", body: keycloakAuditSettings(realm) });
  realm = await (await api("")).json();
  if (!keycloakAuditReady(realm)) {
    throw new Error("Keycloak did not confirm the requested audit-event settings");
  }
  log("Keycloak event auditing: applied with 30-day minimum retention");
  return true;
}

async function main() {
  const mode = process.argv[2];
  if (!new Set(["--check", "--apply"]).has(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/configure-keycloak-audit.mjs --check|--apply");
  }
  const { api } = await connectLocalKeycloak();
  if (!await configureKeycloakAudit(api, { apply: mode === "--apply" })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
