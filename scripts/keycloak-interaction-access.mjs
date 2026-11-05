// Read-only readiness probe. Credentials stay on the validated maintenance
// origin and neither tokens nor secret-bearing responses are logged.
import { localKeycloakRequest } from "./keycloak-account-access.mjs";

export const INTERACTION_PROTOCOL = "inout-app-interactions-v1";
export const INTERACTION_EXTENSION_VERSION = 1;
export const INTERACTION_KEYCLOAK_VERSION = "26.8.1";

export async function interactionProviderReady(api, adminBase, client, request = localKeycloakRequest,
  clientSecret = process.env.KEYCLOAK_CLIENT_SECRET) {
  if (client?.clientId !== "inout-frontend" || typeof client.id !== "string" || !client.id ||
      client.enabled !== true || client.publicClient !== false || client.protocol !== "openid-connect") {
    throw new Error("The enabled confidential inout-frontend client is required");
  }
  // Exercise the exact deployed app credential, not the secret retrieved with
  // maintenance authority: otherwise a stale app secret can pass readiness.
  if (typeof clientSecret !== "string" || !clientSecret || clientSecret.length > 4096) {
    throw new Error("Set KEYCLOAK_CLIENT_SECRET to the frontend application's configured credential");
  }
  const response = await request(`${adminBase}/realms/inout/inout-auth/status`, {
    method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: "Basic " + Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64") },
  });
  if (response.status !== 200 || Number(response.headers.get("Content-Length") || 0) > 4096) {
    void response.body?.cancel().catch(() => {});
    throw new Error("The authenticated app-interaction provider is not ready; rebuild and verify the pinned Keycloak extension first");
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) throw new Error("Invalid app-interaction readiness response");
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  let status;
  try { status = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid app-interaction readiness response"); }
  if (status?.protocol !== INTERACTION_PROTOCOL || status.extensionVersion !== INTERACTION_EXTENSION_VERSION ||
      status.keycloakVersion !== INTERACTION_KEYCLOAK_VERSION) {
    throw new Error("The app-interaction protocol or pinned Keycloak version does not match this application");
  }
  // Custom REST interactions do not execute the standard OAuth policy event
  // contexts. Match the provider's conservative refusal before any cutover
  // writes, even if an enabled policy currently targets another client.
  const policies = await (await api("/client-policies/policies?include-global-policies=true")).json();
  if (!policies || typeof policies !== "object" || Array.isArray(policies) || !Array.isArray(policies.policies) ||
      (policies.globalPolicies != null && !Array.isArray(policies.globalPolicies))) {
    throw new Error("Invalid OAuth client-policy readiness response");
  }
  const entries = [...policies.policies, ...(policies.globalPolicies || [])];
  if (entries.some(policy => !policy || typeof policy !== "object" || Array.isArray(policy) ||
      (policy.enabled != null && typeof policy.enabled !== "boolean"))) {
    throw new Error("Invalid OAuth client-policy readiness response");
  }
  if (entries.some(policy => policy.enabled === true)) {
    throw new Error("Enabled realm/global OAuth client policies require compatibility review before app interactions; no configuration was changed");
  }
  return true;
}
