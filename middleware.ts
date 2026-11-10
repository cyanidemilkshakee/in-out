import { auth } from "./auth"
import { NextResponse } from "next/server"
import { hasAdminAccess, hasMasterAdminAccess } from "./lib/applicationRoles"

const MASTER_ADMIN_PAGES = new Set([
  "/admin",
  "/admin/users",
  "/admin/sso-approvals",
  "/admin/employee-zone-access",
  "/admin/zone-assignments",
  "/admin/entry-restrictions",
])

export default auth((req) => {
  const session = req.auth as { access_token?: string; roles?: unknown } | null
  const isLoggedIn = !!session?.access_token
  const roles = Array.isArray(session?.roles) ? session.roles.filter((role): role is string => typeof role === "string") : []
  const isAdmin = hasAdminAccess(roles)
  const isMasterAdmin = hasMasterAdminAccess(roles)
  const isOperator = roles.includes("operator")
  const canUseTerminal = isAdmin || isOperator
  const isAccessPendingPage = req.nextUrl.pathname === "/access-pending"
  const isAuthPage = req.nextUrl.pathname.startsWith('/login')
  const isUserManagementStepUpLogin =
    req.nextUrl.searchParams.get('stepUp') === '1' &&
    req.nextUrl.searchParams.get('from') === '/admin/users'
  const isAdminPage = req.nextUrl.pathname.startsWith('/admin')
  const isTerminalPage = req.nextUrl.pathname.startsWith('/terminal')
  const home = isMasterAdmin ? '/admin/users' : isAdmin ? '/admin/dashboard' : isOperator ? '/terminal' : '/access-pending'

  if (isAuthPage) {
    if (isLoggedIn) {
      // An administrator with an expired/locked step-up session must be able
      // to reach the sign-in page for a fresh Keycloak authentication.
      if (isAdmin && isUserManagementStepUpLogin) return null
      return NextResponse.redirect(new URL(home, req.url))
    }
    return null
  }

  if (!isLoggedIn && (isAdminPage || isTerminalPage)) {
    let from = req.nextUrl.pathname
    if (req.nextUrl.search) {
      from += req.nextUrl.search
    }
    return NextResponse.redirect(
      new URL(`/login?from=${encodeURIComponent(from)}`, req.url)
    )
  }

  if (req.nextUrl.pathname === '/') {
    return NextResponse.redirect(new URL(isLoggedIn ? home : '/login', req.url))
  }

  if (isAccessPendingPage) {
    if (!isLoggedIn) return NextResponse.redirect(new URL('/login?from=%2Faccess-pending', req.url))
    if (canUseTerminal) return NextResponse.redirect(new URL(home, req.url))
    return null
  }

  if (isAdminPage && !isAdmin) {
    return isOperator
      ? NextResponse.redirect(new URL('/terminal', req.url))
      : NextResponse.redirect(new URL(isLoggedIn ? '/access-pending' : '/access-denied?area=admin', req.url))
  }

  const adminPath = req.nextUrl.pathname.replace(/\/+$/, "") || "/admin"
  if (isAdminPage && isMasterAdmin && !MASTER_ADMIN_PAGES.has(adminPath)) {
    return NextResponse.redirect(new URL('/admin/users', req.url))
  }

  if (isTerminalPage && !canUseTerminal) {
    return NextResponse.redirect(new URL(isLoggedIn ? '/access-pending' : '/access-denied?area=terminal', req.url))
  }

  return null
})

export const config = {
  // The logout return validates its own signed, single-purpose state cookie.
  // Running Auth.js on this public callback can refresh/delete session cookies
  // before that validation, so let the route handle it directly.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|logout/complete).*)'],
}
