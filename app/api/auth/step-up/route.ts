import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../../authSession";
import type { AppSession } from "../../../../lib/keycloakSession";
import { isActiveUserManagementStepUp, isStepUpDurationMinutes, signStepUpIntent, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, userManagementStepUpLockMaxAge, verifyStepUpIntent } from "../../../../lib/userManagementStepUp";
import { readJsonBody, RequestBodyError } from "../../../../lib/requestJson";
import { lockUserManagementWindow, userManagementWindowUnlocked } from "../../../../lib/serverUserManagement";
import { PythonApiError } from "../../pythonApi";
import { authRequestOrigin, isSameOriginAuthRequest } from "../../../../lib/authRequestBoundary";
import { hasAdminAccess } from "../../../../lib/applicationRoles";

function secureCookie(request: Request) {
  try {
    return new URL(authRequestOrigin(request.url, process.env.AUTH_URL || process.env.NEXTAUTH_URL)).protocol === "https:";
  } catch {
    return new URL(request.url).protocol === "https:";
  }
}

async function authorizeRequest(request: Request): Promise<{ session: AppSession } | { response: NextResponse }> {
  if (!isSameOriginAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL)) {
    return { response: NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 }) };
  }

  const session = await apiSession();
  if (!session?.access_token) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!hasAdminAccess(session.roles)) {
    return { response: NextResponse.json({ error: "Administrator access is required." }, { status: 403 }) };
  }
  return { session };
}

async function getStepUp(request: NextRequest) {
  const session = await apiSession();
  if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!hasAdminAccess(session.roles)) {
    return NextResponse.json({ error: "Administrator access is required." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const now = Date.now();
  const unlocked = isActiveUserManagementStepUp(session, now) && !request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) && await userManagementWindowUnlocked(session);
  return NextResponse.json({ unlocked, expiresAt: unlocked ? session.stepUpExpiresAt : null }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

async function startStepUp(request: NextRequest) {
  const authorization = await authorizeRequest(request);
  if ("response" in authorization) return authorization.response;
  const { session } = authorization;
  if (!session.subject) return NextResponse.json({ error: "A verified administrator identity is required." }, { status: 401 });
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  let durationMinutes: unknown;
  try {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "durationMinutes")) {
      return NextResponse.json({ error: "Choose a re-authentication window." }, { status: 400 });
    }
    durationMinutes = (body as Record<string, unknown>).durationMinutes;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: error instanceof RequestBodyError ? error.status : 400 });
  }
  if (!isStepUpDurationMinutes(durationMinutes)) {
    return NextResponse.json({ error: "Choose 5, 10, 15, 20, 30 minutes, or 1 hour." }, { status: 400 });
  }
  const now = Date.now();
  const pendingIntent = await verifyStepUpIntent(request.cookies.get(USER_MANAGEMENT_STEP_UP_COOKIE)?.value, secret, now);
  // Retrying a password after a failed attempt must preserve the original
  // extension deadline. The prior preparation already locked that window.
  const retryBase = pendingIntent?.subject === session.subject && pendingIntent.baseExpiresAt === session.stepUpExpiresAt &&
    isActiveUserManagementStepUp(session, now) ? pendingIntent.baseExpiresAt : undefined;
  const baseExpiresAt = request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE)
    ? retryBase
    : await userManagementWindowUnlocked(session) ? session.stepUpExpiresAt : undefined;
  await lockUserManagementWindow(session);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_COOKIE, await signStepUpIntent(now, secret, session.subject, durationMinutes, baseExpiresAt), {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: 10 * 60, path: "/",
  });
  // Starting a login cannot reactivate the previous window if login is canceled.
  response.cookies.set(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, "1", {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: userManagementStepUpLockMaxAge(session, now), path: "/",
  });
  return response;
}

async function lockStepUp(request: NextRequest) {
  const authorization = await authorizeRequest(request);
  if ("response" in authorization) return authorization.response;
  const { session } = authorization;
  await lockUserManagementWindow(session);
  const response = NextResponse.json({ locked: true });
  response.cookies.delete({ name: USER_MANAGEMENT_STEP_UP_COOKIE, path: "/" });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, "1", {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: userManagementStepUpLockMaxAge(session, Date.now()), path: "/",
  });
  return response;
}

function protectedStepUp(handler: (request: NextRequest) => Promise<Response>) {
  return withApiSession(async (request) => {
    try { return await handler(request); }
    catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Authentication service is unavailable." }, {
        status: error instanceof PythonApiError ? error.status : 503,
        headers: error instanceof PythonApiError && error.retryAfter ? { "Retry-After": error.retryAfter } : undefined,
      });
    }
  });
}

export const GET = protectedStepUp(getStepUp);
export const POST = protectedStepUp(startStepUp);
export const DELETE = protectedStepUp(lockStepUp);
