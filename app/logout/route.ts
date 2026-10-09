import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";

const LOGOUT_INTENT_COOKIE = "inout_logout_intent";

function publicAppUrl(request: NextRequest) {
  const appUrl = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url);
  if (appUrl.hostname === "0.0.0.0" || appUrl.hostname === "::") appUrl.hostname = "localhost";
  return appUrl;
}

function signLogoutIntent(offlineUntil: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const signature = createHmac("sha256", secret).update(offlineUntil).digest("base64url");
  return `${offlineUntil}.${signature}`;
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const allowedOrigins = new Set([publicAppUrl(request).origin, request.nextUrl.origin]);
      if (!allowedOrigins.has(new URL(origin).origin)) return new NextResponse("Invalid logout request.", { status: 403 });
    } catch {
      return new NextResponse("Invalid logout request.", { status: 403 });
    }
  }

  let minutes = 30;
  const formData = await request.formData();
  const duration = formData.get("offlineDurationMinutes");
  if (duration !== null) {
    minutes = typeof duration === "string" ? Number(duration) : Number.NaN;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1_440) {
      return new NextResponse("Choose an expected return time between 5 minutes and 24 hours.", { status: 400 });
    }
  }

  const session = await auth() as AppSession | null;
  const isAdmin = Boolean(session?.access_token && session.roles.includes("admin"));
  const response = NextResponse.redirect(new URL("/logout/complete", publicAppUrl(request)), 303);
  if (isAdmin && session?.access_token) {
    const offlineUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    const apiUrl = process.env.PYTHON_API_URL?.replace(/\/$/, "");
    if (apiUrl) {
      await fetch(`${apiUrl}/v1/admin/profile/availability`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ offlineUntil }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
    const logoutIntent = signLogoutIntent(offlineUntil);
    if (logoutIntent) response.cookies.set(LOGOUT_INTENT_COOKIE, logoutIntent, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicAppUrl(request).protocol === "https:",
      maxAge: 10 * 60,
      path: "/",
    });
  }
  return response;
}
