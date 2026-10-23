import { boundedIdentityResponse, verifyKeycloakToken, verifyKeycloakTokenPair, type KeycloakTokenConfig } from "./keycloakTokenValidation"

export type CredentialsFailureCode = "credentials" | "account_setup_required" | "service_unavailable"
export class KeycloakCredentialsError extends Error {
  constructor(readonly code: CredentialsFailureCode) {
    super("Sign-in could not be completed.")
  }
}

type CredentialsConfig = KeycloakTokenConfig & { clientSecret: string }
type VerifiedClaims = Awaited<ReturnType<typeof verifyKeycloakToken>>
type TokenVerifier = (value: unknown, config: KeycloakTokenConfig, kind: "access" | "id", subject?: string) => Promise<VerifiedClaims>
export type VerifiedCredentials = {
  id: string
  name?: string
  email?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  authTime: number
  roles: string[]
}

/** Passwords are forwarded once to the configured identity provider, never
 * persisted in a session or retried automatically. All returned identity
 * claims must pass signature, issuer, audience, subject and freshness checks.
 */
export async function authenticateKeycloakCredentials(
  credentials: Partial<Record<"username" | "password" | "otp", unknown>>,
  config: CredentialsConfig,
  fetcher: typeof fetch = fetch,
  verify: TokenVerifier = verifyKeycloakToken,
): Promise<VerifiedCredentials> {
  const { username, password, otp } = credentials
  if (typeof username !== "string" || !username.trim() || username.length > 254 || /[\u0000-\u001f\u007f]/.test(username) ||
      typeof password !== "string" || !password || password.length > 128 ||
      (otp !== undefined && (typeof otp !== "string" || (otp !== "" && !/^\d{6,8}$/.test(otp))))) {
    throw new KeycloakCredentialsError("credentials")
  }
  const startedAt = Math.floor(Date.now() / 1000)
  try {
    const body = new URLSearchParams({
      grant_type: "password", client_id: config.clientId, client_secret: config.clientSecret,
      username: username.trim(), password, scope: "openid profile email",
    })
    if (otp) body.set("totp", otp)
    const response = await boundedIdentityResponse(await fetcher(
      `${(config.jwksIssuer || config.issuer).replace(/\/$/, "")}/protocol/openid-connect/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      },
    ))
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new KeycloakCredentialsError("service_unavailable")
      const error = await response.json().catch(() => null)
      if (error?.error === "invalid_grant" && error?.error_description === "Account is not fully set up") {
        throw new KeycloakCredentialsError("account_setup_required")
      }
      // Disabled accounts, bad passwords, absent/wrong OTPs, and unknown names
      // deliberately receive the same public response.
      throw new KeycloakCredentialsError("credentials")
    }
    const tokens = await response.json() as Record<string, unknown>
    if (typeof tokens.access_token !== "string" || typeof tokens.id_token !== "string" ||
        typeof tokens.refresh_token !== "string" || !tokens.refresh_token || tokens.refresh_token.length > 32 * 1024 ||
        typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
        !Number.isSafeInteger(tokens.expires_in) || Number(tokens.expires_in) <= 0 || Number(tokens.expires_in) > 86_400) {
      throw new Error("Invalid identity response.")
    }
    const access = await verify(tokens.access_token, config, "access")
    const identity = await verify(tokens.id_token, config, "id", access.sub)
    await verifyKeycloakTokenPair(tokens.access_token, access, identity)
    if (!access.sub || Number(identity.iat) < startedAt - 30 || Number(access.iat) < startedAt - 30) {
      throw new Error("Identity response does not match this sign-in.")
    }
    // Direct grants prove a new password verification. Some Keycloak versions
    // omit auth_time for this grant; only here may the freshly signed iat stand
    // in for it. Token refresh never creates a new authentication time.
    const authTime = identity.auth_time ?? access.auth_time ?? identity.iat
    if (!Number.isSafeInteger(authTime) || Number(authTime) < startedAt - 30 || Number(authTime) > Math.floor(Date.now() / 1000) + 30) {
      throw new Error("Fresh authentication was not confirmed.")
    }
    const realmAccess = access.realm_access as { roles?: unknown } | undefined
    const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((role): role is string => typeof role === "string") : []
    return {
      id: access.sub, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Math.min(startedAt + Number(tokens.expires_in), Number(access.exp)), authTime: Number(authTime), roles,
      name: typeof identity.name === "string" ? identity.name.slice(0, 256) : undefined,
      email: typeof identity.email === "string" ? identity.email.slice(0, 254) : undefined,
    }
  } catch (error) {
    if (error instanceof KeycloakCredentialsError) throw error
    // Never expose provider responses, tokens, user passwords or crypto errors.
    throw new KeycloakCredentialsError("service_unavailable")
  }
}

export async function revokeKeycloakRefreshToken(refreshToken: string, config: CredentialsConfig, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await boundedIdentityResponse(await fetcher(
    `${(config.jwksIssuer || config.issuer).replace(/\/$/, "")}/protocol/openid-connect/revoke`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: config.clientId, client_secret: config.clientSecret }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    },
  ))
  if (!response.ok) throw new Error("Identity session revocation failed.")
}
