import type { Session } from "next-auth"
import type { JWT } from "next-auth/jwt"

export type RoleToken = JWT & {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  provider?: string
  roles?: string[]
  auth_time?: number
  step_up_expires_at?: number
  error?: "RefreshTokenError"
}

export type AppSession = Session & {
  access_token?: string
  provider?: string
  roles: string[]
  authTime?: number
  stepUpExpiresAt?: number
  error?: "RefreshTokenError"
}

function accessTokenClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {}
  try {
    const encoded = value.split(".")[1]
    if (!encoded) return {}
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
    const payload = JSON.parse(atob(base64))
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function rolesFromAccessToken(value: unknown): string[] {
  const payload = accessTokenClaims(value) as { realm_access?: { roles?: unknown } }
  const roles = payload.realm_access?.roles
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : []
}

export function authTimeFromAccessToken(value: unknown): number | undefined {
  const authTime = accessTokenClaims(value).auth_time
  return typeof authTime === "number" && Number.isFinite(authTime) ? authTime : undefined
}

export function invalidSession(token: RoleToken, error: RoleToken["error"] = "RefreshTokenError"): RoleToken {
  return { ...token, access_token: undefined, refresh_token: undefined, expires_at: undefined, roles: [], error }
}

export async function refreshKeycloakToken(
  token: RoleToken,
  config: { issuer?: string; clientId?: string; clientSecret?: string },
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
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: token.refresh_token,
        client_id: config.clientId, client_secret: config.clientSecret,
      }),
    })
    if (!response.ok) return invalidSession(token)
    const refreshed = await response.json() as Record<string, unknown>
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token ||
        typeof refreshed.expires_in !== "number" || !Number.isFinite(refreshed.expires_in) || refreshed.expires_in <= 0 ||
        typeof refreshed.token_type !== "string" || refreshed.token_type.toLowerCase() !== "bearer" ||
        (refreshed.refresh_token !== undefined && (typeof refreshed.refresh_token !== "string" || !refreshed.refresh_token))) {
      return invalidSession(token)
    }
    return {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: (refreshed.refresh_token as string | undefined) ?? token.refresh_token,
      expires_at: Math.floor(now / 1000) + refreshed.expires_in,
      roles: rolesFromAccessToken(refreshed.access_token),
      auth_time: authTimeFromAccessToken(refreshed.access_token),
      error: undefined,
    }
  } catch {
    return invalidSession(token)
  }
}

export function keycloakSession(session: Session, token: RoleToken, serverOnly: boolean): AppSession {
  // Explicitly construct the public shape: never return the JWT or refresh token.
  return {
    user: session.user,
    expires: session.expires,
    provider: token.provider,
    roles: token.error ? [] : token.roles ?? [],
    authTime: token.auth_time,
    stepUpExpiresAt: token.step_up_expires_at,
    error: token.error,
    ...(serverOnly && !token.error ? { access_token: token.access_token } : {}),
  }
}

export function keycloakLogoutUrl(issuer: string, clientId: string, appUrl: string, returnPath = "/login"): string {
  const url = new URL(`${issuer.replace(/\/$/, "")}/protocol/openid-connect/logout`)
  url.search = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: new URL(returnPath, appUrl).href }).toString()
  return url.href
}
