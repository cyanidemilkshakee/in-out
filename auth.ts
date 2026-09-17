import NextAuth, { customFetch, type NextAuthConfig } from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import { keycloakSession, refreshKeycloakToken, rolesFromAccessToken, type RoleToken } from "./lib/keycloakSession"

const keycloakConfigured = !!process.env.KEYCLOAK_CLIENT_ID &&
  !!process.env.KEYCLOAK_CLIENT_SECRET && !!process.env.KEYCLOAK_ISSUER
const keycloakPublicIssuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER

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
        const roleToken: RoleToken = account ? {
          ...token,
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          expires_at: account.expires_at,
          provider: account.provider,
          roles: rolesFromAccessToken(account.access_token),
          error: undefined,
        } : token as RoleToken
        return refreshKeycloakToken(roleToken, {
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
