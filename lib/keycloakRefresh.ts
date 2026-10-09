import "server-only"

import { invalidSession, refreshKeycloakToken, type RoleToken } from "./keycloakSession"

type RefreshConfig = { issuer?: string; clientId?: string; clientSecret?: string }
type RefreshedFields = Pick<RoleToken, "access_token" | "refresh_token" | "expires_at" | "roles" | "auth_time" | "error">
type RefreshEntry = {
  expiresAt: number
  promise: Promise<RefreshedFields>
  settled: boolean
}

// NextAuth may run its JWT callback for several parallel requests carrying the
// same cookie. A rotating Keycloak refresh token must only be exchanged once.
// Keep successful results briefly so requests with the old cookie that arrive
// just after the first exchange can use the same rotated token.
const refreshes = new Map<string, RefreshEntry>()
const REFRESH_RESULT_TTL_MS = 30_000
const MAX_REFRESH_RESULTS = 1_000

async function refreshCacheKey(refreshToken: string, config: RefreshConfig): Promise<string> {
  const value = `${config.issuer?.replace(/\/$/, "")}\0${config.clientId}\0${refreshToken}`
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function refreshedFields(token: RoleToken): RefreshedFields {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
    roles: token.roles,
    auth_time: token.auth_time,
    error: token.error,
  }
}

function pruneRefreshes(now: number): void {
  for (const [key, entry] of refreshes) {
    if (entry.expiresAt <= now) refreshes.delete(key)
  }

  if (refreshes.size <= MAX_REFRESH_RESULTS) return
  for (const [key, entry] of refreshes) {
    if (refreshes.size <= MAX_REFRESH_RESULTS) break
    // Never evict an in-flight exchange: that could allow a second use of the
    // same refresh token while Keycloak is still processing the first.
    if (entry.settled) refreshes.delete(key)
  }
}

export async function refreshKeycloakTokenSingleFlight(
  token: RoleToken,
  config: RefreshConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RoleToken> {
  if (token.error || !token.access_token || !Number.isFinite(token.expires_at) ||
      now < token.expires_at! * 1000 - 30_000 || !token.refresh_token ||
      !config.issuer || !config.clientId || !config.clientSecret) {
    return refreshKeycloakToken(token, config, fetcher, now)
  }

  pruneRefreshes(now)
  const key = await refreshCacheKey(token.refresh_token, config)
  const cached = refreshes.get(key)
  if (cached && cached.expiresAt > now) {
    return { ...token, ...await cached.promise }
  }

  let entry: RefreshEntry
  const promise = refreshKeycloakToken(token, config, fetcher, now)
    .then((refreshed) => {
      const fields = refreshedFields(refreshed)
      entry.settled = true
      if (fields.access_token) {
        entry.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS
      } else if (refreshes.get(key) === entry) {
        // A failed or transient refresh must not poison later retries.
        refreshes.delete(key)
      }
      pruneRefreshes(Date.now())
      return fields
    }, () => {
      entry.settled = true
      if (refreshes.get(key) === entry) refreshes.delete(key)
      return refreshedFields(invalidSession(token))
    })

  entry = { expiresAt: now + REFRESH_RESULT_TTL_MS, promise, settled: false }
  refreshes.set(key, entry)
  pruneRefreshes(now)

  return { ...token, ...await promise }
}
