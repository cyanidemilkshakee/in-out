import { createRemoteJWKSet, customFetch } from "jose/jwks/remote"
import { jwtVerify } from "jose/jwt/verify"
import type { JWTPayload, JWTVerifyGetKey } from "jose"

export type KeycloakTokenConfig = { issuer: string; clientId: string; jwksIssuer?: string }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

// Applies to discovery, token and key responses. No unbounded provider response
// or redirect may turn a sign-in into memory exhaustion or credential forwarding.
export async function boundedIdentityResponse(response: Response, maxBytes = 128 * 1024): Promise<Response> {
  const length = response.headers.get("content-length")
  const redirected = response.status >= 300 && response.status < 400
  const invalidLength = length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBytes))
  if (redirected || invalidLength) {
    // A rejected response still owns its network stream. Cancel without waiting
    // for an untrusted provider's cancellation hook to release that connection.
    void response.body?.cancel().catch(() => {})
    throw new Error(redirected ? "Identity provider redirected unexpectedly." : "Identity response is too large.")
  }
  const reader = response.body?.getReader()
  if (!reader) return response
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Identity response timed out.")), 10_000) })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout])
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error("Identity response is too large.")
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const headers = new Headers(response.headers)
  // fetch decompresses bodies; do not retain wire-level encoding/length.
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers })
}

function keySet(config: KeycloakTokenConfig) {
  const url = `${(config.jwksIssuer || config.issuer).replace(/\/$/, "")}/protocol/openid-connect/certs`
  let keys = keySets.get(url)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), {
      timeoutDuration: 5_000, cacheMaxAge: 300_000, cooldownDuration: 30_000,
      [customFetch]: async (input, init) => boundedIdentityResponse(await fetch(input, { ...init, redirect: "error", cache: "no-store" })),
    })
    keySets.set(url, keys)
  }
  return keys
}

export async function verifyKeycloakToken(
  value: unknown, config: KeycloakTokenConfig, kind: "access" | "id", expectedSubject?: string,
  keys: JWTVerifyGetKey = keySet(config),
) {
  if (typeof value !== "string" || !value || value.length > 32 * 1024) throw new Error("Invalid identity token.")
  const { payload } = await jwtVerify(value, keys, {
    issuer: config.issuer.replace(/\/$/, ""), audience: config.clientId,
    algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "iss", "aud"], clockTolerance: 10,
  })
  const now = Math.floor(Date.now() / 1000)
  const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud
  if (typeof payload.sub !== "string" || !payload.sub || (expectedSubject && payload.sub !== expectedSubject) ||
      !Array.isArray(audiences) || !audiences.length || audiences.some((audience) => typeof audience !== "string" || !audience) ||
      !Number.isSafeInteger(payload.iat) || Number(payload.iat) <= 0 || Number(payload.iat) > now + 30 ||
      !Number.isSafeInteger(payload.exp) || Number(payload.exp) <= now || Number(payload.exp) <= Number(payload.iat) ||
      (payload.azp !== undefined && payload.azp !== config.clientId) ||
      (kind === "id" && audiences.length > 1 && payload.azp !== config.clientId) ||
      payload.typ !== (kind === "access" ? "Bearer" : "ID") ||
      [payload.sid, payload.session_state].some((session) => session !== undefined && (typeof session !== "string" || !session)) ||
      (payload.auth_time !== undefined && (!Number.isSafeInteger(payload.auth_time) || Number(payload.auth_time) <= 0 ||
        Number(payload.auth_time) > now + 30 || Number(payload.auth_time) > Number(payload.iat) + 30))) {
    throw new Error("Identity token does not match this session.")
  }
  return payload
}

/** Bind independently verified RS256 access and ID tokens from one response.
 * Signature, issuer, audience and token-kind verification must precede this.
 */
export async function verifyKeycloakTokenPair(accessToken: string, access: JWTPayload, identity: JWTPayload): Promise<void> {
  if (!access.sub || access.sub !== identity.sub ||
      (access.auth_time !== undefined && identity.auth_time !== undefined && access.auth_time !== identity.auth_time)) {
    throw new Error("Identity tokens do not belong to the same authentication.")
  }
  // Keycloak copies sid from the access token to the ID token. Older realms
  // may expose session_state instead; absent optional claims remain supported.
  const sessions = [access.sid, access.session_state, identity.sid, identity.session_state]
    .filter((session) => session !== undefined)
  if (sessions.some((session) => typeof session !== "string" || !session || session !== sessions[0])) {
    throw new Error("Identity tokens do not belong to the same session.")
  }
  if (identity.at_hash !== undefined) {
    if (typeof identity.at_hash !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(identity.at_hash)) {
      throw new Error("Invalid access token binding.")
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest).subarray(0, 16)))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    if (identity.at_hash !== expected) throw new Error("Access token binding does not match.")
  }
}
