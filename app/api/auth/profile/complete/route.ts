import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../../../authSession";
import { isSameOriginAuthRequest } from "../../../../../lib/authRequestBoundary";
import { readJsonBody, RequestBodyError } from "../../../../../lib/requestJson";
import { completeKeycloakProfile, prepareKeycloakProfile, ProfileSetupError } from "../../../../../lib/keycloakProfileSetup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } });
}

function csrfVerified(request: NextRequest, token: unknown, secret: string): boolean {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
  const secure = new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).protocol === "https:";
  const stored = request.cookies.get(secure ? "__Host-authjs.csrf-token" : "authjs.csrf-token")?.value;
  if (!stored) return false;
  const [value, signature, extra] = stored.split("|");
  if (extra !== undefined || value !== token || !/^[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const expected = createHash("sha256").update(token + secret).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

async function completeProfile(request: NextRequest) {
  if (!isSameOriginAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL)) {
    return json({ error: "Request origin is not allowed." }, 403);
  }
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return json({ error: "Profile updates are not configured." }, 503);
  let input: Record<string, unknown>;
  try {
    const body = await readJsonBody(request, 8 * 1024, 5_000);
    const fields = ["username", "currentPassword", "email", "firstName", "lastName", "otp", "csrfToken"];
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
      return json({ error: "Profile update request is invalid." }, 400);
    }
    input = body as Record<string, unknown>;
  } catch (error) {
    return json({ error: error instanceof RequestBodyError ? error.message : "Profile update request is invalid." },
      error instanceof RequestBodyError ? error.status : 400);
  }
  if (!csrfVerified(request, input.csrfToken, secret)) return json({ error: "Refresh the page and try again." }, 403);
  if (typeof input.username !== "string" || !input.username.trim() || input.username.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(input.username) || typeof input.currentPassword !== "string" ||
      !input.currentPassword || input.currentPassword.length > 128 || typeof input.email !== "string" ||
      !input.email.trim() || input.email.length > 254 || typeof input.firstName !== "string" ||
      !input.firstName.trim() || input.firstName.length > 256 || typeof input.lastName !== "string" ||
      !input.lastName.trim() || input.lastName.length > 256 ||
      [input.email, input.firstName, input.lastName].some((value) => typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)) ||
      (input.otp !== undefined && (typeof input.otp !== "string" || (input.otp !== "" && !/^\d{6,8}$/.test(input.otp))))) {
    return json({ error: "Enter your email, first name, last name, and current password." }, 400);
  }
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return json({ error: "Profile updates are not configured. Contact your administrator." }, 503);
  try {
    const deadline = AbortSignal.timeout(35_000);
    const fetcher = (url: URL | RequestInfo, init?: RequestInit) => fetch(url, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
    const profileInput = { username: input.username, currentPassword: input.currentPassword,
      email: input.email, firstName: input.firstName, lastName: input.lastName,
      otp: input.otp as string | undefined };
    const targetSubject = await prepareKeycloakProfile(profileInput, {
      issuer, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE, clientId, clientSecret,
    }, fetcher);
    const session = await apiSession();
    if (session?.subject && session.subject !== targetSubject) {
      return json({ error: "Sign out of the other account before completing profile setup." }, 409);
    }
    await completeKeycloakProfile(profileInput, targetSubject, {
      issuer, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE, clientId, clientSecret,
    }, fetcher);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof ProfileSetupError) return json({ error: error.message }, error.status);
    console.error("[profile-setup] Request could not be completed.");
    return json({ error: "Profile updates are temporarily unavailable. Please try again later." }, 503);
  }
}

export const POST = withApiSession(completeProfile);
