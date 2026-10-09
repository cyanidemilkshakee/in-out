"use server"

import { redirect } from "next/navigation"
import { signOut } from "../auth"
import { keycloakLogoutUrl } from "../lib/keycloakSession"

export async function logout() {
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER
  const clientId = process.env.KEYCLOAK_CLIENT_ID
  const appUrl = process.env.AUTH_URL
  const destination = issuer && clientId && appUrl ? keycloakLogoutUrl(issuer, clientId, appUrl) : "/login"
  await signOut({ redirect: false })
  redirect(destination)
}
