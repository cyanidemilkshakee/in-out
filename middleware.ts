import { auth } from "./auth"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export default auth((req) => {
  const session = req.auth as { access_token?: string; roles?: unknown } | null
  const isLoggedIn = !!session?.access_token
  const roles = Array.isArray(session?.roles) ? session.roles.filter((role): role is string => typeof role === "string") : []
  const isAdmin = roles.includes("admin")
  const isOperator = roles.includes("operator") && !isAdmin
  const isAuthPage = req.nextUrl.pathname.startsWith('/login')
  const isAdminPage = req.nextUrl.pathname.startsWith('/admin')
  const isTerminalPage = req.nextUrl.pathname.startsWith('/terminal')
  const home = isAdmin ? '/admin/dashboard' : '/terminal'

  if (isAuthPage) {
    if (isLoggedIn) {
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

  if (isAdminPage && !isAdmin) {
    return isOperator
      ? NextResponse.redirect(new URL('/terminal', req.url))
      : new NextResponse('Forbidden', { status: 403 })
  }

  if (isTerminalPage && !isOperator) {
    return isAdmin
      ? NextResponse.redirect(new URL('/admin/dashboard', req.url))
      : new NextResponse('Forbidden', { status: 403 })
  }

  return null
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
