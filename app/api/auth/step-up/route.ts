import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import type { AppSession } from "../../../../lib/keycloakSession";
import { isActiveUserManagementStepUp, isStepUpDurationMinutes, signStepUpIntent, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, userManagementStepUpLockMaxAge } from "../../../../lib/userManagementStepUp";
import { readJsonBody, RequestBodyError } from "../../../../lib/requestJson";

function secureCookie(request: Request) {
  try {
    return new URL(process.env.AUTH_URL || request.url).protocol === "https:";
  } catch {
    return new URL(request.url).protocol === "https:";
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin) return false;
    const allowedOrigins = new Set([new URL(request.url).origin]);
    if (process.env.AUTH_URL) allowedOrigins.add(new URL(process.env.AUTH_URL).origin);
    return allowedOrigins.has(parsedOrigin.origin);
  } catch {
    return false;
  }
}

async function authorizeRequest(request: Request): Promise<{ session: AppSession } | { response: NextResponse }> {
  if (!sameOrigin(request)) {
    return { response: NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 }) };
  }

  const session = await auth() as AppSession | null;
  if (!session?.access_token) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!Array.isArray(session.roles) || !session.roles.includes("admin")) {
    return { response: NextResponse.json({ error: "Administrator access is required." }, { status: 403 }) };
  }
  return { session };
}

export async function GET(request: NextRequest) {
  const session = await auth() as AppSession | null;
  if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!Array.isArray(session.roles) || !session.roles.includes("admin")) {
    return NextResponse.json({ error: "Administrator access is required." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const now = Date.now();
  const unlocked = isActiveUserManagementStepUp(session, now) && !request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE);
  return NextResponse.json({ unlocked, expiresAt: unlocked ? session.stepUpExpiresAt : null }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeRequest(request);
  if ("response" in authorization) return authorization.response;
  const { session } = authorization;
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
  const baseExpiresAt = !request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) && isActiveUserManagementStepUp(session, now)
    ? session.stepUpExpiresAt
    : undefined;
  const response = NextResponse.json({ ok: true });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_COOKIE, await signStepUpIntent(now, secret, durationMinutes, baseExpiresAt), {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: 10 * 60, path: "/",
  });
  // Starting a login cannot reactivate the previous window if login is canceled.
  response.cookies.set(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, "1", {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: userManagementStepUpLockMaxAge(session, now), path: "/",
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeRequest(request);
  if ("response" in authorization) return authorization.response;
  const { session } = authorization;
  const response = NextResponse.json({ locked: true });
  response.cookies.delete({ name: USER_MANAGEMENT_STEP_UP_COOKIE, path: "/" });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, "1", {
    httpOnly: true, sameSite: "lax", secure: secureCookie(request), maxAge: userManagementStepUpLockMaxAge(session, Date.now()), path: "/",
  });
  return response;
}
