import { boundedIdentityResponse, type KeycloakTokenConfig } from "./keycloakTokenValidation"

export type KeycloakInteractionConfig = KeycloakTokenConfig & { clientSecret: string }
export type InteractionAction = "prepare" | "verify" | "token"
export const INTERACTION_PROTOCOL = "inout-app-interactions-v1"

/** This is a version-pinned custom provider protocol. There is deliberately no
 * fallback to password grants or privileged administrative password resets. */
export function keycloakInteractionEndpoint(config: KeycloakInteractionConfig, action: InteractionAction): string {
  if (typeof config.clientId !== "string" || !config.clientId || config.clientId.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(config.clientId) || typeof config.clientSecret !== "string" ||
      !config.clientSecret || config.clientSecret.length > 1024) throw new Error("Invalid identity configuration.")
  const issuer = new URL(config.jwksIssuer || config.issuer)
  if (!["http:", "https:"].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash ||
      !/^.*\/realms\/[^/]+\/?$/.test(issuer.pathname)) throw new Error("Invalid identity configuration.")
  return `${issuer.href.replace(/\/$/, "")}/inout-auth/${action}`
}

export async function keycloakInteractionRequest(
  config: KeycloakInteractionConfig, action: InteractionAction, input: Record<string, unknown>, fetcher: typeof fetch = fetch,
): Promise<Response> {
  const endpoint = keycloakInteractionEndpoint(config, action)
  // OAuth client-password encoding avoids ambiguity if either credential
  // contains reserved characters. The secret never enters a JSON response.
  const authorization = "Basic " + btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)
  return boundedIdentityResponse(await fetcher(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(input), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
  }))
}

export function validInteractionSubject(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function interactionVerifier(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

export async function interactionChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}
