"use server"

import { redirect } from "next/navigation"
import { cookies, headers } from "next/headers"
import { createHmac } from "node:crypto"
import { keycloakLogoutUrl } from "../lib/keycloakSession"

const LOGOUT_INTENT_COOKIE = "inout_logout_intent"

function signLogoutIntent(offlineUntil: string) {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is required to sign out")
  const signature = createHmac("sha256", secret).update(offlineUntil).digest("base64url")
  return `${offlineUntil}.${signature}`
}

async function publicAppUrl(): Promise<string | undefined> {
  const requestHeaders = await headers()
  const origin = requestHeaders.get("origin")
  if (origin) {
    try {
      const url = new URL(origin)
      if (url.hostname !== "0.0.0.0") return url.origin
    } catch { /* Fall back to the configured public URL. */ }
  }
  const configured = process.env.AUTH_URL
  if (!configured) return undefined
  try {
    const url = new URL(configured)
    // 0.0.0.0 is only a server bind address, never a browser destination.
    if (url.hostname === "0.0.0.0") url.hostname = "localhost"
    if (url.port === "1001" && process.env.PUBLIC_PORT) url.port = process.env.PUBLIC_PORT
    return url.origin
  } catch {
    return undefined
  }
}

export async function beginLogout(formData: FormData) {
  const minutes = Number(formData.get("offlineDurationMinutes"))
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1_440) {
    throw new Error("Choose an expected return time between 5 minutes and 24 hours.")
  }
  const offlineUntil = new Date(Date.now() + minutes * 60_000).toISOString()
  const cookieStore = await cookies()
  cookieStore.set(LOGOUT_INTENT_COOKIE, signLogoutIntent(offlineUntil), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60,
    path: "/",
  })
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER
  const clientId = process.env.KEYCLOAK_CLIENT_ID
  const appUrl = await publicAppUrl()
  const destination = issuer && clientId && appUrl ? keycloakLogoutUrl(issuer, clientId, appUrl, "/logout/complete") : "/login"
  redirect(destination)
}

/** Logout for non-admin surfaces. The local app cookie is cleared only after
 * Keycloak completes its own confirmation flow. */
export async function logout() {
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER
  const clientId = process.env.KEYCLOAK_CLIENT_ID
  const appUrl = await publicAppUrl()
  const destination = issuer && clientId && appUrl ? keycloakLogoutUrl(issuer, clientId, appUrl, "/logout/complete") : "/login"
  redirect(destination)
}
