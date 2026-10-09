import NextAuth, { customFetch, type NextAuthConfig } from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import { cookies } from "next/headers"
import { authTimeFromToken, keycloakSession, rolesFromAccessToken, type RoleToken } from "./lib/keycloakSession"
import { refreshKeycloakTokenSingleFlight } from "./lib/keycloakRefresh"
import { completedStepUpWindow, USER_MANAGEMENT_STEP_UP_COOKIE, verifyStepUpIntent } from "./lib/userManagementStepUp"

const keycloakConfigured = !!process.env.KEYCLOAK_CLIENT_ID &&
  !!process.env.KEYCLOAK_CLIENT_SECRET && !!process.env.KEYCLOAK_ISSUER
const keycloakPublicIssuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER

async function clearAdminOfflineStatus(accessToken: unknown): Promise<void> {
  const apiUrl = process.env.PYTHON_API_URL?.replace(/\/$/, "")
  if (typeof accessToken !== "string" || !accessToken || !apiUrl || !rolesFromAccessToken(accessToken).includes("admin")) return
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

async function completedUserManagementStepUp(idToken: unknown) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return undefined;
  const cookieStore = await cookies();
  const intent = await verifyStepUpIntent(cookieStore.get(USER_MANAGEMENT_STEP_UP_COOKIE)?.value, secret);
  return intent ? completedStepUpWindow(intent, authTimeFromToken(idToken)) : undefined;
}

// Both instances share the same provider/cookie configuration. Only the
// internal instance exposes the bearer token; HTTP handlers always filter it.
function keycloakConfig(serverOnly: boolean): NextAuthConfig {
  return {
    providers: keycloakConfigured ? [Keycloak({
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
      issuer: keycloakPublicIssuer!,
      checks: ["pkce", "state", "nonce"],
      [customFetch]: (input, init) => {
        const url = String(input)
        const issuer = keycloakPublicIssuer!.replace(/\/$/, "")
        const internal = process.env.KEYCLOAK_JWKS_BASE?.replace(/\/$/, "")
        return fetch(internal && url.startsWith(issuer + "/") ? internal + url.slice(issuer.length) : input, init)
      },
      authorization: { url: `${keycloakPublicIssuer}/protocol/openid-connect/auth`, params: { scope: "openid profile email" } },
    })] : [],
    pages: { signIn: "/login" },
    callbacks: {
      async jwt({ token, account }) {
        if (account) {
          await clearAdminOfflineStatus(account.access_token)
          const stepUp = await completedUserManagementStepUp(account.id_token)
          const roleToken: RoleToken = {
          ...token,
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_at: account.expires_at,
          provider: account.provider,
          roles: rolesFromAccessToken(account.access_token),
          auth_time: authTimeFromToken(account.id_token),
          step_up_expires_at: stepUp?.expiresAt,
          step_up_duration_minutes: stepUp?.durationMinutes,
          step_up_extension_seconds: stepUp?.extensionSeconds,
          error: undefined,
          }
          return roleToken
        }
        return refreshKeycloakTokenSingleFlight(token as RoleToken, {
          issuer: process.env.KEYCLOAK_JWKS_BASE || keycloakPublicIssuer,
          clientId: process.env.KEYCLOAK_CLIENT_ID,
          clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
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
