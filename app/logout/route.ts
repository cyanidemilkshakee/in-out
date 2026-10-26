import { NextRequest, NextResponse } from "next/server";
import { auth, signOut } from "../../auth";
import type { AppSession } from "../../lib/keycloakSession";
import { keycloakLogoutUrl } from "../../lib/keycloakSession";
import { USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../lib/userManagementStepUp";
import { createLogoutIntent, LOGOUT_INTENT_COOKIE } from "../../lib/logoutIntent";
import { lockUserManagementWindow } from "../../lib/serverUserManagement";
import { AuthRequestError, isSameOriginAuthRequest, prepareAuthRequest } from "../../lib/authRequestBoundary";
import { revokeKeycloakRefreshToken } from "../../lib/keycloakCredentials";
import { hasAdminAccess } from "../../lib/applicationRoles";

function publicAppUrl(request: NextRequest) {
  const appUrl = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url);
  if (appUrl.hostname === "0.0.0.0" || appUrl.hostname === "::") appUrl.hostname = "localhost";
  return appUrl;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL)) {
    return new NextResponse("Invalid logout request.", { status: 403 });
  }

  let minutes = 30;
  let formData: URLSearchParams;
  try {
    const prepared = await prepareAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new AuthRequestError("Invalid logout request.", 415);
    formData = new URLSearchParams(prepared.body);
    if ([...formData.keys()].some((key) => key !== "offlineDurationMinutes")) throw new AuthRequestError("Invalid logout request.", 400);
  } catch (error) { return new NextResponse("Invalid logout request.", { status: error instanceof AuthRequestError ? error.status : 400 }); }
  const duration = formData.get("offlineDurationMinutes");
  if (duration !== null) {
    minutes = typeof duration === "string" ? Number(duration) : Number.NaN;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1_440) {
      return new NextResponse("Choose an expected return time between 5 minutes and 24 hours.", { status: 400 });
    }
  }

  if (!process.env.AUTH_SECRET) return new NextResponse("Authentication is not configured.", { status: 503 });
  const session = await auth() as AppSession | null;
  const isAdmin = Boolean(session?.access_token && hasAdminAccess(session.roles));
  if (isAdmin && session) {
    try { await lockUserManagementWindow(session); }
    catch {
      // Logout must clear this browser even while the API is unavailable.
      // The provider logout below also ends the associated SSO session.
      console.warn("[auth] User-management lock unavailable during logout.");
    }
  }
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
  }
  // Clear the local session before leaving the application. An unavailable
  // identity provider must not leave this browser signed into the app.
  await signOut({ redirect: false });
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC ?? process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const appUrl = publicAppUrl(request);
  if (session?.provider === "credentials") {
    // Revoke the provider refresh session before returning to the app form.
    // An earlier optional setup login may also have left browser SSO behind.
    if (session.refresh_token && issuer && clientId && process.env.KEYCLOAK_CLIENT_SECRET) {
      try {
        await revokeKeycloakRefreshToken(session.refresh_token, {
          issuer, clientId, clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
          jwksIssuer: process.env.KEYCLOAK_JWKS_BASE,
        });
      } catch { console.warn("[auth] Identity session revocation unavailable during logout."); }
    }
    if (!request.cookies.has("inout_browser_sso")) {
      const response = NextResponse.redirect(new URL("/login", appUrl), 303);
      response.headers.set("Cache-Control", "no-store");
      response.cookies.delete(USER_MANAGEMENT_STEP_UP_COOKIE);
      response.cookies.delete(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE);
      response.cookies.set(LOGOUT_INTENT_COOKIE, "", { path: "/logout/complete", maxAge: 0 });
      return response;
    }
  }
  const intent = createLogoutIntent(process.env.AUTH_SECRET);
  // End browser SSO even when the local bearer just expired or failed refresh.
  const destination = issuer && clientId
    ? keycloakLogoutUrl(issuer, clientId, appUrl.href, "/logout/complete")
    : new URL("/logout/complete", appUrl);
  const destinationUrl = new URL(destination);
  destinationUrl.searchParams.set("state", intent.nonce);
  const response = NextResponse.redirect(destinationUrl, 303);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(LOGOUT_INTENT_COOKIE, intent.cookie, {
    httpOnly: true, sameSite: "lax", secure: appUrl.protocol === "https:", maxAge: 300, path: "/logout/complete",
  });
  response.cookies.delete(USER_MANAGEMENT_STEP_UP_COOKIE);
  response.cookies.delete(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE);
  response.cookies.delete("inout_browser_sso");
  return response;
}
