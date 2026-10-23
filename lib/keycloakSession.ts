import type { Session } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { boundedIdentityResponse } from "./keycloakTokenValidation"

export type KeycloakRefreshConfig = {
  issuer?: string; clientId?: string; clientSecret?: string
  validateAccessToken: (value: string, expectedSubject: string | undefined) => Promise<void>
}

export type RoleToken = JWT & {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  provider?: string
  roles?: string[]
  auth_time?: number
  step_up_expires_at?: number
  step_up_duration_minutes?: number
  step_up_extension_seconds?: number
  step_up_window_id?: string
  step_up_intent_id?: string
  error?: "RefreshTokenError"
}

export type AppSession = Session & {
  subject?: string
  access_token?: string
  refresh_token?: string
  provider?: string
  roles: string[]
  authTime?: number
  stepUpExpiresAt?: number
  stepUpDurationMinutes?: number
  stepUpExtensionSeconds?: number
  stepUpWindowId?: string
  error?: "RefreshTokenError"
}

function tokenClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {}
  try {
    const encoded = value.split(".")[1]
    if (!encoded) return {}
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))))
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function rolesFromAccessToken(value: unknown): string[] {
  const payload = tokenClaims(value) as { realm_access?: { roles?: unknown } }
  const roles = payload.realm_access?.roles
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : []
}

export function subjectFromAccessToken(value: unknown): string | undefined {
  const subject = tokenClaims(value).sub
  return typeof subject === "string" && subject ? subject : undefined
}

/** Read auth_time from an OIDC token. For a fresh-login step-up, pass the
 * ID token: Keycloak normally places auth_time there, not in the access token.
 */
export function authTimeFromToken(value: unknown): number | undefined {
  const authTime = tokenClaims(value).auth_time
  return typeof authTime === "number" && Number.isSafeInteger(authTime) && authTime > 0 ? authTime : undefined
}

export function invalidSession(token: RoleToken, error: RoleToken["error"] = "RefreshTokenError"): RoleToken {
  return { ...token, access_token: undefined, refresh_token: undefined, expires_at: undefined, roles: [],
    auth_time: undefined, step_up_expires_at: undefined, step_up_duration_minutes: undefined,
    step_up_extension_seconds: undefined, step_up_window_id: undefined, step_up_intent_id: undefined, error }
}

export async function refreshKeycloakToken(
  token: RoleToken,
  config: KeycloakRefreshConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RoleToken> {
  // An invalid refresh token must not be retried on every subsequent request.
  if (token.error) return invalidSession(token)
  if (!token.access_token || !Number.isFinite(token.expires_at)) return invalidSession(token)
  if (now < token.expires_at! * 1000 - 30_000) return token
  if (!token.refresh_token || !config.issuer || !config.clientId || !config.clientSecret) return invalidSession(token)

  try {
    const response = await fetcher(`${config.issuer.replace(/\/$/, "")}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: token.refresh_token,
        client_id: config.clientId, client_secret: config.clientSecret,
      }),
    })
    if (!response.ok) return invalidSession(token)
    const refreshed = await (await boundedIdentityResponse(response)).json() as Record<string, unknown>
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token ||
        typeof refreshed.expires_in !== "number" || !Number.isSafeInteger(refreshed.expires_in) || refreshed.expires_in <= 0 || refreshed.expires_in > 86_400 ||
        typeof refreshed.token_type !== "string" || refreshed.token_type.toLowerCase() !== "bearer" ||
        (refreshed.refresh_token !== undefined && (typeof refreshed.refresh_token !== "string" || !refreshed.refresh_token))) {
      return invalidSession(token)
    }
    await config.validateAccessToken(refreshed.access_token, subjectFromAccessToken(token.access_token) ?? token.sub)
    const refreshedAuthTime = authTimeFromToken(refreshed.access_token)
    if (refreshedAuthTime !== undefined && token.auth_time !== undefined && refreshedAuthTime !== token.auth_time) return invalidSession(token)
    const jwtExpiry = tokenClaims(refreshed.access_token).exp
    const expiresAt = Math.floor(now / 1000) + refreshed.expires_in
    return {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: (refreshed.refresh_token as string | undefined) ?? token.refresh_token,
      expires_at: typeof jwtExpiry === "number" && Number.isSafeInteger(jwtExpiry) ? Math.min(expiresAt, jwtExpiry) : expiresAt,
      roles: rolesFromAccessToken(refreshed.access_token),
      // Refresh responses generally do not carry auth_time. Preserve the
      // original authentication time unless the new token explicitly has it.
      auth_time: token.auth_time ?? refreshedAuthTime,
      error: undefined,
    }
  } catch {
    return invalidSession(token)
  }
}

export function keycloakSession(session: Session, token: RoleToken, serverOnly: boolean): AppSession {
  // Only the server-only auth instance receives bearer and refresh tokens.
  return {
    user: session.user,
    // The Python API authorizes and scopes terminal assignments using the
    // bearer token's `sub`. Use that same principal in the browser so the UI,
    // offline queue and API cannot disagree about which account is active.
    subject: token.error ? undefined : subjectFromAccessToken(token.access_token) ?? token.sub,
    expires: session.expires,
    provider: token.provider,
    roles: token.error ? [] : token.roles ?? [],
    authTime: token.auth_time,
    stepUpExpiresAt: token.step_up_expires_at,
    stepUpDurationMinutes: token.step_up_duration_minutes,
    stepUpExtensionSeconds: token.step_up_extension_seconds,
    error: token.error,
    ...(serverOnly && !token.error ? { access_token: token.access_token, refresh_token: token.refresh_token, stepUpWindowId: token.step_up_window_id } : {}),
  }
}

export function keycloakLogoutUrl(issuer: string, clientId: string, appUrl: string, returnPath = "/login"): string {
  const url = new URL(`${issuer.replace(/\/$/, "")}/protocol/openid-connect/logout`)
  url.search = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: new URL(returnPath, appUrl).href }).toString()
  return url.href
}
