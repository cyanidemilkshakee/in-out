import { NextResponse } from "next/server";
import { auth } from "../../../../auth";
import type { AppSession } from "../../../../lib/keycloakSession";
import { signStepUpIntent, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../../lib/userManagementStepUp";

function secureCookie() {
  return process.env.AUTH_URL?.startsWith("https://") ?? false;
}

export async function POST() {
  const session = await auth() as AppSession | null;
  if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!session.roles.includes("admin")) return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_COOKIE, await signStepUpIntent(Date.now(), secret), {
    httpOnly: true, sameSite: "lax", secure: secureCookie(), maxAge: 10 * 60, path: "/",
  });
  response.cookies.delete({ name: USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, path: "/" });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ locked: true });
  response.cookies.delete({ name: USER_MANAGEMENT_STEP_UP_COOKIE, path: "/" });
  response.cookies.set(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, "1", {
    httpOnly: true, sameSite: "lax", secure: secureCookie(), maxAge: 300, path: "/",
  });
  return response;
}
