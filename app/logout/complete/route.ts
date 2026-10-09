import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth, signOut } from "../../../auth";
import type { AppSession } from "../../../lib/keycloakSession";

const LOGOUT_INTENT_COOKIE = "inout_logout_intent";

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

function verifiedOfflineUntil(value: string | undefined): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!value || !secret) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const offlineUntil = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(offlineUntil).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const date = new Date(offlineUntil);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() && date.getTime() <= Date.now() + 24 * 60 * 60_000 ? offlineUntil : null;
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const offlineUntil = verifiedOfflineUntil(cookieStore.get(LOGOUT_INTENT_COOKIE)?.value);
  const session = await auth() as AppSession | null;
  if (offlineUntil && session?.access_token && session.roles.includes("admin")) {
    const apiUrl = process.env.PYTHON_API_URL?.replace(/\/$/, "");
    if (apiUrl) {
      await fetch(`${apiUrl}/v1/admin/profile/availability`, {
        method: "PATCH", cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ offlineUntil }),
      }).catch(() => undefined);
    }
  }
  await signOut({ redirect: false });
  const response = NextResponse.redirect(publicLoginUrl(request), 303);
  response.cookies.delete(LOGOUT_INTENT_COOKIE);
  return response;
}
