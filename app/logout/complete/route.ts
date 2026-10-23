import { NextRequest, NextResponse } from "next/server";
import { LOGOUT_INTENT_COOKIE, validLogoutIntent } from "../../../lib/logoutIntent";

function publicAppUrl(request: NextRequest) {
  // request.url may contain the Next.js container bind address when traffic
  // came through the local reverse proxy. AUTH_URL is the browser-facing URL.
  const appUrl = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url);
  if (appUrl.hostname === "0.0.0.0" || appUrl.hostname === "::") appUrl.hostname = "localhost";
  return appUrl;
}

function publicLoginUrl(request: NextRequest) {
  return new URL("/login", publicAppUrl(request));
}

export async function GET(request: NextRequest) {
  if (!validLogoutIntent(request.cookies.get(LOGOUT_INTENT_COOKIE)?.value, request.nextUrl.searchParams.get("state"), process.env.AUTH_SECRET)) {
    return new NextResponse("Invalid or expired logout return.", { status: 403 });
  }
  // POST already cleared the local session. A delayed provider return must
  // never erase a new session established in another tab in the meantime.
  const response = NextResponse.redirect(publicLoginUrl(request), 303);
  response.cookies.delete({ name: LOGOUT_INTENT_COOKIE, path: "/logout/complete" });
  // A delayed return also must not clear a newer pending re-authentication or
  // its lock; those belong to the current session in another tab.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
