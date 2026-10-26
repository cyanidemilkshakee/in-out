// Fill empty new-install secret fields only. Never rotate an existing service.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const file = new URL("../.env", import.meta.url);
const secrets = new Set(["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "MIGRATION_DB_PASSWORD", "KEYCLOAK_DB_PASSWORD",
  "TEMPORAL_DB_PASSWORD", "REDIS_QUOTA_PASSWORD", "REDIS_EVENTS_PASSWORD", "REDIS_GATEWAY_PASSWORD", "KONG_IDENTITY_SECRET",
  "AUTH_SECRET", "KEYCLOAK_CLIENT_SECRET", "KEYCLOAK_ADMIN_PASSWORD"]);
const text = await readFile(file, "utf8");
let filled = 0;
const updated = text.replace(/^([A-Z_]+)=([^\r\n]*)/gm, (line, key, value) => {
  if (!secrets.has(key) || value.trim()) return line;
  filled++;
  return `${key}=${randomBytes(32).toString("base64url")}`;
});
await writeFile(file, updated, { mode: 0o600 });
console.log(`Filled ${filled} empty secret fields. Existing values were preserved; persisted services were not changed.`);
