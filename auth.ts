import NextAuth, { CredentialsSignin, customFetch, type NextAuthConfig } from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import Credentials from "next-auth/providers/credentials"
import { cookies } from "next/headers"
import { authTimeFromToken, invalidSession, keycloakSession, rolesFromAccessToken, subjectFromAccessToken, type RoleToken } from "./lib/keycloakSession"
import { refreshKeycloakTokenSingleFlight } from "./lib/keycloakRefresh"
import { completedStepUpWindow, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, verifyStepUpIntent } from "./lib/userManagementStepUp"
import { safeAuthRedirect } from "./lib/authRequestBoundary"
import { boundedIdentityResponse, verifyKeycloakToken, verifyKeycloakTokenPair } from "./lib/keycloakTokenValidation"
import { authenticateKeycloakCredentials, KeycloakCredentialsError, type VerifiedCredentials } from "./lib/keycloakCredentials"
import { hasAdminAccess } from "./lib/applicationRoles"

const keycloakConfigured = !!process.env.KEYCLOAK_CLIENT_ID &&
  !!process.env.KEYCLOAK_CLIENT_SECRET && !!process.env.KEYCLOAK_ISSUER
const keycloakPublicIssuer = (process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER)?.replace(/\/+$/, "")

async function clearAdminOfflineStatus(accessToken: unknown): Promise<void> {
  const apiUrl = process.env.PYTHON_API_URL?.replace(/\/$/, "")
  if (typeof accessToken !== "string" || !accessToken || !apiUrl || !hasAdminAccess(rolesFromAccessToken(accessToken))) return
  try {
    await fetch(`${apiUrl}/v1/admin/profile/availability`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ offlineUntil: null }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Availability must never block a valid Keycloak sign-in.
  }
}

class AppCredentialsSignin extends CredentialsSignin {
  constructor(code: string, readonly signinStage?: string, readonly providerStatus?: number) { super(); this.code = code }
}

async function completedUserManagementStepUp(authTime: number | undefined, subject: string, roles: string[]) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return undefined;
  const cookieStore = await cookies();
  const intent = await verifyStepUpIntent(cookieStore.get(USER_MANAGEMENT_STEP_UP_COOKIE)?.value, secret);
  const window = intent && hasAdminAccess(roles) ? completedStepUpWindow(intent, authTime, subject) : undefined;
  return window ? { ...window, intentId: intent!.intentId } : undefined;
}

async function enforceStepUpIdentity(subject: string, roles: string[], authTime?: number, requireFreshAuthTime = false) {
  const cookieStore = await cookies();
  const intentCookie = cookieStore.get(USER_MANAGEMENT_STEP_UP_COOKIE)?.value;
  if (!intentCookie) {
    if (cookieStore.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE)) throw new AppCredentialsSignin("step_up_expired");
    return;
  }
  const secret = process.env.AUTH_SECRET;
  const intent = secret ? await verifyStepUpIntent(intentCookie, secret) : null;
  if (!intent) throw new AppCredentialsSignin("step_up_expired");
  if (intent.subject !== subject || !hasAdminAccess(roles)) {
    throw new AppCredentialsSignin("step_up_account_mismatch");
  }
  if (requireFreshAuthTime && !completedStepUpWindow(intent, authTime, subject)) {
    throw new AppCredentialsSignin("step_up_expired");
  }
}

// Both instances share the same provider/cookie configuration. Only the
// internal instance exposes the bearer token; HTTP handlers always filter it.
function keycloakConfig(serverOnly: boolean): NextAuthConfig {
  const keycloakProvider = (passwordAction?: "setup" | "change") => {
    const provider = Keycloak({
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
      issuer: keycloakPublicIssuer!,
      checks: ["pkce", "state", "nonce"],
      [customFetch]: (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        const issuer = keycloakPublicIssuer!.replace(/\/$/, "")
        const internal = process.env.KEYCLOAK_JWKS_BASE?.replace(/\/$/, "")
        if (!url.startsWith(issuer + "/")) throw new Error("Unexpected identity endpoint.")
        return fetch(internal && url.startsWith(issuer + "/") ? internal + url.slice(issuer.length) : input, {
          ...init, redirect: "error", cache: "no-store",
          signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        }).then((response) => boundedIdentityResponse(response))
      },
      authorization: {
        url: `${keycloakPublicIssuer}/protocol/openid-connect/auth`,
        params: {
          scope: "openid profile email",
          ...(passwordAction
            ? { kc_action: "UPDATE_PASSWORD", prompt: "login", max_age: "0" }
            : { kc_idp_hint: "zoho" }),
        },
      },
    })
    return passwordAction ? {
      ...provider,
      id: `keycloak-password-${passwordAction}`,
      name: `InOut password ${passwordAction}`,
    } : provider
  }

  return {
    logger: {
      error(error: unknown) {
        // Provider/library messages and nested causes can contain token
        // responses. Log only error classes and source locations for diagnosis.
        const types: string[] = []
        const seen = new Set<unknown>()
        let current: unknown = error
        while (current && typeof current === "object" && !seen.has(current) && types.length < 5) {
          seen.add(current)
          const value = current as { name?: unknown; type?: unknown; cause?: unknown }
          const name = typeof value.type === "string" ? value.type
            : typeof value.name === "string" ? value.name : "Error"
          types.push(name)
          current = value.cause
        }
        const signinCode = error && typeof error === "object" &&
          (error as { type?: unknown }).type === "CredentialsSignin" &&
          ["credentials", "account_setup_required", "profile_setup_required", "account_action_required", "service_unavailable"].includes((error as { code?: string }).code ?? "")
          ? (error as { code: string }).code : undefined
        const diagnostic = error && typeof error === "object" ? error as { signinStage?: unknown; providerStatus?: unknown } : undefined
        const signinStage = ["verify_request", "verify_http", "verify_payload", "token_request", "token_http",
          "token_payload", "token_validation", "internal"].includes(String(diagnostic?.signinStage))
          ? diagnostic?.signinStage as string : undefined
        const providerStatus = typeof diagnostic?.providerStatus === "number" && Number.isInteger(diagnostic.providerStatus) &&
          diagnostic.providerStatus >= 100 && diagnostic.providerStatus <= 599 ? diagnostic.providerStatus : undefined
        const stack = error instanceof Error && typeof error.stack === "string"
          ? error.stack.split("\n").slice(1, 5).map((line) => line.trim())
          : []
        console.error("[auth] Authentication could not be completed.", { types, ...(signinCode ? { signinCode } : {}),
          ...(signinStage ? { signinStage } : {}), ...(providerStatus ? { providerStatus } : {}), stack })
      },
    },
    session: { strategy: "jwt" },
    providers: keycloakConfigured ? [Credentials({
      name: "InOut",
      credentials: { username: {}, password: { type: "password" }, otp: {} },
      async authorize(credentials) {
        try {
          const identity = await authenticateKeycloakCredentials(credentials, {
            issuer: keycloakPublicIssuer!, clientId: process.env.KEYCLOAK_CLIENT_ID!,
            clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE,
          })
          await enforceStepUpIdentity(identity.id, identity.roles)
          return { id: identity.id, name: identity.name, email: identity.email, verifiedIdentity: identity }
        } catch (error) {
          if (error instanceof AppCredentialsSignin) throw error
          const failure = error instanceof KeycloakCredentialsError ? error : undefined
          throw new AppCredentialsSignin(failure?.code ?? "service_unavailable", failure?.stage, failure?.providerStatus)
        }
      },
    }), keycloakProvider(), keycloakProvider("setup"), keycloakProvider("change")] : [],
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      async redirect({ url, baseUrl }) {
        return safeAuthRedirect(url, process.env.AUTH_URL || process.env.NEXTAUTH_URL || baseUrl)
      },
      async jwt({ token, account, user }) {
        if (account) {
          if (account.provider === "credentials") {
            const identity = (user as { verifiedIdentity?: VerifiedCredentials } | undefined)?.verifiedIdentity
            if (!identity || identity.id !== account.providerAccountId) return null
            const stepUp = await completedUserManagementStepUp(identity.authTime, identity.id, identity.roles)
            await clearAdminOfflineStatus(identity.accessToken)
            return {
              ...token, sub: identity.id, provider: "credentials",
              access_token: identity.accessToken, refresh_token: identity.refreshToken,
              expires_at: identity.expiresAt, roles: identity.roles, auth_time: identity.authTime,
              step_up_expires_at: stepUp?.expiresAt, step_up_duration_minutes: stepUp?.durationMinutes,
              step_up_extension_seconds: stepUp?.extensionSeconds,
              step_up_window_id: stepUp ? crypto.randomUUID() : undefined,
              step_up_intent_id: stepUp?.intentId, error: undefined,
            } satisfies RoleToken
          }
          if (!new Set(["keycloak", "keycloak-password-setup", "keycloak-password-change"]).has(account.provider)) return null
          const accessToken = account.access_token
          const idToken = account.id_token
          if (typeof accessToken !== "string") return null
          const subject = subjectFromAccessToken(accessToken)
          if (!subject || subject !== account.providerAccountId) return null
          const verification = { issuer: keycloakPublicIssuer!, clientId: process.env.KEYCLOAK_CLIENT_ID!, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE }
          let verifiedAccess
          try {
            const verifiedIdentity = await verifyKeycloakToken(idToken, verification, "id", subject)
            verifiedAccess = await verifyKeycloakToken(accessToken, verification, "access", subject)
            await verifyKeycloakTokenPair(accessToken, verifiedAccess, verifiedIdentity)
          } catch {
            // Provider claim errors may include private payloads in their cause.
            // Fail closed without sending those payloads to Auth.js's logger.
            return null
          }
          const roles = rolesFromAccessToken(accessToken)
          await enforceStepUpIdentity(subject, roles, authTimeFromToken(idToken), true)
          if (account.provider !== "keycloak-password-change") await clearAdminOfflineStatus(accessToken)
          const stepUp = await completedUserManagementStepUp(authTimeFromToken(idToken), subject, roles)
          const roleToken: RoleToken = {
          ...token,
          sub: subject,
          access_token: accessToken,
          refresh_token: account.refresh_token,
          expires_at: Math.min(account.expires_at ?? Number(verifiedAccess.exp), Number(verifiedAccess.exp)),
          provider: "keycloak",
          roles,
          auth_time: authTimeFromToken(idToken),
          step_up_expires_at: stepUp?.expiresAt,
          step_up_duration_minutes: stepUp?.durationMinutes,
          step_up_extension_seconds: stepUp?.extensionSeconds,
          step_up_window_id: stepUp ? crypto.randomUUID() : undefined,
          step_up_intent_id: stepUp?.intentId,
          error: undefined,
          }
          return roleToken
        }
        if (token.provider !== "keycloak" && token.provider !== "credentials") return invalidSession(token as RoleToken)
        return refreshKeycloakTokenSingleFlight(token as RoleToken, {
          issuer: process.env.KEYCLOAK_JWKS_BASE || keycloakPublicIssuer,
          clientId: process.env.KEYCLOAK_CLIENT_ID,
          clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
          validateAccessToken: async (value, subject) => {
            await verifyKeycloakToken(value, { issuer: keycloakPublicIssuer!, clientId: process.env.KEYCLOAK_CLIENT_ID!, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE }, "access", subject)
          },
        })
      },
      async session({ session, token }) {
        return keycloakSession(session, token as RoleToken, serverOnly)
      },
    },
  }
}

export const { signIn, signOut, auth } = NextAuth(keycloakConfig(true))
export const { handlers } = NextAuth(keycloakConfig(false))

export const keycloakEnabled = keycloakConfigured
