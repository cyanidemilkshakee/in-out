import { boundedIdentityResponse, verifyKeycloakToken, verifyKeycloakTokenPair, type KeycloakTokenConfig } from "./keycloakTokenValidation"
import { interactionChallenge, interactionVerifier, keycloakInteractionRequest, validInteractionSubject } from "./keycloakInteractions"

export type CredentialsFailureCode = "credentials" | "account_setup_required" | "profile_setup_required" | "account_action_required" | "service_unavailable"
export type CredentialsFailureStage = "verify_request" | "verify_http" | "verify_payload" |
  "token_request" | "token_http" | "token_payload" | "token_validation" | "internal"
export class KeycloakCredentialsError extends Error {
  constructor(readonly code: CredentialsFailureCode, readonly stage?: CredentialsFailureStage, readonly providerStatus?: number) {
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
    const codeVerifier = interactionVerifier()
    let proof: Response
    try {
      proof = await keycloakInteractionRequest(config, "verify", { mode: "login", username: username.trim(),
        currentPassword: password, ...(otp ? { otp } : {}), codeChallenge: await interactionChallenge(codeVerifier) }, fetcher)
    } catch {
      throw new KeycloakCredentialsError("service_unavailable", "verify_request")
    }
    if (!proof.ok) {
      if (proof.status === 429 || proof.status >= 500) throw new KeycloakCredentialsError("service_unavailable", "verify_http", proof.status)
      const error = await proof.json().catch(() => null)
      if (proof.status === 409 && error?.error === "account_setup_required") throw new KeycloakCredentialsError("account_setup_required")
      if (proof.status === 409 && error?.error === "profile_setup_required") throw new KeycloakCredentialsError("profile_setup_required")
      if (proof.status === 409 && error?.error === "not_ready") throw new KeycloakCredentialsError("account_action_required")
      if (proof.status === 401 && error?.error === "credentials") throw new KeycloakCredentialsError("credentials")
      throw new KeycloakCredentialsError("service_unavailable", "verify_http", proof.status)
    }
    let interaction: Record<string, unknown>
    try { interaction = await proof.json() as Record<string, unknown> }
    catch { throw new KeycloakCredentialsError("service_unavailable", "verify_payload") }
    if (typeof interaction.code !== "string" || !/^[A-Za-z0-9_-]{43,256}$/.test(interaction.code) ||
        !Number.isSafeInteger(interaction.expiresIn) || Number(interaction.expiresIn) <= 0 || Number(interaction.expiresIn) > 60 ||
        !validInteractionSubject(interaction.subject)) throw new KeycloakCredentialsError("service_unavailable", "verify_payload")
    let response: Response
    try { response = await keycloakInteractionRequest(config, "token", { code: interaction.code, codeVerifier }, fetcher) }
    catch { throw new KeycloakCredentialsError("service_unavailable", "token_request") }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new KeycloakCredentialsError("service_unavailable", "token_http", response.status)
      // A consumed/expired code cannot be replayed and is never retried with
      // the user's password. Ask for a new sign-in instead of minting a session.
      throw new KeycloakCredentialsError("service_unavailable", "token_http", response.status)
    }
    let tokens: Record<string, unknown>
    try { tokens = await response.json() as Record<string, unknown> }
    catch { throw new KeycloakCredentialsError("service_unavailable", "token_payload") }
    if (typeof tokens.access_token !== "string" || typeof tokens.id_token !== "string" ||
        typeof tokens.refresh_token !== "string" || !tokens.refresh_token || tokens.refresh_token.length > 32 * 1024 ||
        typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
        !Number.isSafeInteger(tokens.expires_in) || Number(tokens.expires_in) <= 0 || Number(tokens.expires_in) > 86_400) {
      throw new KeycloakCredentialsError("service_unavailable", "token_payload")
    }
    let access: VerifiedClaims
    let identity: VerifiedClaims
    try {
      access = await verify(tokens.access_token, config, "access", interaction.subject)
      identity = await verify(tokens.id_token, config, "id", access.sub)
      await verifyKeycloakTokenPair(tokens.access_token, access, identity)
    } catch {
      throw new KeycloakCredentialsError("service_unavailable", "token_validation")
    }
    if (!access.sub || Number(identity.iat) < startedAt - 30 || Number(access.iat) < startedAt - 30) {
      throw new KeycloakCredentialsError("service_unavailable", "token_validation")
    }
    // The custom provider explicitly records authentication time after proof.
    // Token issuance time is not a substitute for evidence of authentication.
    const authTime = identity.auth_time ?? access.auth_time
    if (!Number.isSafeInteger(authTime) || Number(authTime) < startedAt - 30 || Number(authTime) > Math.floor(Date.now() / 1000) + 30) {
      throw new KeycloakCredentialsError("service_unavailable", "token_validation")
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
    throw new KeycloakCredentialsError("service_unavailable", "internal")
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
