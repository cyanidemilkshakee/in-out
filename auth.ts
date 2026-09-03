import NextAuth from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import Credentials from "next-auth/providers/credentials"

// Keycloak is optional — only include the provider when all three env vars are set.
// If any is missing, the OIDC discovery call would throw at startup.
const keycloakConfigured =
  !!process.env.KEYCLOAK_CLIENT_ID &&
  !!process.env.KEYCLOAK_CLIENT_SECRET &&
  !!process.env.KEYCLOAK_ISSUER &&
  process.env.KEYCLOAK_ISSUER !== "http://localhost:8080/realms/inout"

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined
        const password = credentials?.password as string | undefined

        // Dev / local admin fallback — replace with a real DB lookup once
        // the user management API is implemented.
        if (
          (email === "admin" || email === "admin@inout.local") &&
          password === "admin"
        ) {
          return { id: "admin-1", name: "Admin User", email: "admin@inout.local" }
        }

        return null
      },
    }),
    ...(keycloakConfigured
      ? [
          Keycloak({
            clientId: process.env.KEYCLOAK_CLIENT_ID!,
            clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
            issuer: process.env.KEYCLOAK_ISSUER!,
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
  },
})

// Export whether Keycloak is available so the login page can conditionally
// render the SSO button without crashing.
export const keycloakEnabled = keycloakConfigured
