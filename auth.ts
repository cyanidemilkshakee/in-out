import NextAuth, { customFetch } from "next-auth"
import type { JWT } from "next-auth/jwt"
import Keycloak from "next-auth/providers/keycloak"

type RoleToken = JWT & {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  provider?: string
  roles?: string[]
}

function rolesFromAccessToken(value: unknown): string[] {
  if (typeof value !== "string") return []
  try {
    const encoded = value.split(".")[1]
    if (!encoded) return []
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
    const payload = JSON.parse(atob(base64)) as { realm_access?: { roles?: unknown } }
    const roles = payload.realm_access?.roles
    return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : []
  } catch {
    return []
  }
}

// Keycloak is optional — only included when all three env vars are present.
const keycloakConfigured =
  !!process.env.KEYCLOAK_CLIENT_ID &&
  !!process.env.KEYCLOAK_CLIENT_SECRET &&
  !!process.env.KEYCLOAK_ISSUER

// Validate the public issuer while routing server requests over the Docker network.
const keycloakPublicIssuer =
  process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    ...(keycloakConfigured
      ? [
          Keycloak({
            clientId: process.env.KEYCLOAK_CLIENT_ID!,
            clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
            // Server-side discovery/token/JWKS calls go here (internal Docker hostname).
            issuer: process.env.KEYCLOAK_ISSUER!,
            [customFetch]: (input, init) => {
              const url = String(input);
              const issuer = process.env.KEYCLOAK_ISSUER!;
              const internal = process.env.KEYCLOAK_JWKS_BASE;
              return fetch(internal && url.startsWith(issuer + "/") ? internal + url.slice(issuer.length) : input, init);
            },
            // Browser sign-in redirect must use the externally-reachable URL.
            authorization: `${keycloakPublicIssuer}/protocol/openid-connect/auth`,
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    // Persist the Keycloak access_token and refresh_token in the NextAuth JWT
    // so the BFF can forward it as a Bearer token to the Python API.
    async jwt({ token, account }) {
      const roleToken = token as RoleToken
      if (account) {
        roleToken.access_token = account.access_token
        roleToken.refresh_token = account.refresh_token
        roleToken.expires_at = account.expires_at
        roleToken.provider = account.provider
        roleToken.roles = rolesFromAccessToken(account.access_token)
      }
      if (roleToken.expires_at && Date.now() >= Number(roleToken.expires_at) * 1000 - 30000 && roleToken.refresh_token) {
        try {
          const response = await fetch((process.env.KEYCLOAK_JWKS_BASE ?? process.env.KEYCLOAK_ISSUER) + "/protocol/openid-connect/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(roleToken.refresh_token), client_id: process.env.KEYCLOAK_CLIENT_ID!, client_secret: process.env.KEYCLOAK_CLIENT_SECRET! }),
          });
          if (!response.ok) throw new Error("Token refresh failed");
          const refreshed = await response.json();
          roleToken.access_token = refreshed.access_token;
          roleToken.refresh_token = refreshed.refresh_token ?? roleToken.refresh_token;
          roleToken.expires_at = Math.floor(Date.now() / 1000) + refreshed.expires_in;
          roleToken.roles = rolesFromAccessToken(refreshed.access_token)
        } catch { roleToken.access_token = undefined; roleToken.roles = []; }
      }
      return roleToken
    },
    // Expose the access_token on the client-side session object.
    async session({ session, token }: { session: any; token: RoleToken }) {
      session.access_token = token.access_token
      session.provider = token.provider
      session.roles = token.roles ?? []
      return session
    },
  },
})

// Export whether Keycloak is available so the login page can conditionally
// render the SSO button without crashing.
export const keycloakEnabled = keycloakConfigured
