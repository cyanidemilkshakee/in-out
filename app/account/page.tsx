import { redirect } from "next/navigation"
import { auth } from "../../auth"
import type { AppSession } from "../../lib/keycloakSession"

export const dynamic = "force-dynamic"

export default async function AccountPage() {
  const session = await auth() as AppSession | null
  if (!session?.access_token) redirect("/login?from=%2Faccount")
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER
  if (!issuer) throw new Error("Keycloak issuer is not configured")
  redirect(`${issuer.replace(/\/$/, "")}/account/`)
}
