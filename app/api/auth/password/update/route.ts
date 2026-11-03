import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../../../authSession";
import { isSameOriginAuthRequest } from "../../../../../lib/authRequestBoundary";
import { readJsonBody, RequestBodyError } from "../../../../../lib/requestJson";
import { PasswordUpdateError, updateKeycloakPassword } from "../../../../../lib/keycloakPasswordUpdate";
import { USER_MANAGEMENT_STEP_UP_COOKIE } from "../../../../../lib/userManagementStepUp";

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

class LeaseError extends PasswordUpdateError {
  constructor(status: number) { super(status === 409 ? "state_changed" : "service_unavailable", status, status === 409
    ? "Another password update is in progress. Wait a moment before trying again."
    : "Password updates are temporarily unavailable. Please try again later."); }
}

async function withUserLock<T>(subject: string, operation: () => Promise<T>): Promise<T> {
  const base = process.env.PASSWORD_UPDATE_LOCK_API_URL?.replace(/\/$/, "");
  const secret = process.env.AUTH_SECRET;
  if (!base || !secret || secret.length < 32) throw new LeaseError(503);
  const signingSecret = secret;
  const leaseId = randomUUID();
  async function lease(action: "acquire" | "release") {
    const body = JSON.stringify({ subject, leaseId, action });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", signingSecret).update(`inout:password-update-lease:v1\n${timestamp}\n${body}`).digest("hex");
    const response = await fetch(`${base}/internal/password-updates/lease`, {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json", "X-Inout-Password-Lease-Time": timestamp,
        "X-Inout-Password-Lease-Signature": signature }, body,
    });
    if (!response.ok) throw new LeaseError(response.status === 409 ? 409 : 503);
    void response.body?.cancel().catch(() => {});
  }
  try { await lease("acquire"); } catch (error) { throw error instanceof LeaseError ? error : new LeaseError(503); }
  let retain = false;
  try { return await operation(); }
  catch (error) {
    // A reset may have committed after a response was lost. Retain the short
    // lease so an immediate retry cannot race that unconfirmed provider write.
    retain = error instanceof PasswordUpdateError && error.code === "update_unconfirmed";
    throw error;
  } finally {
    if (!retain) {
      try { await lease("release"); }
      catch { console.warn("[password-update] Lease cleanup deferred to expiry."); }
    }
  }
}

async function updatePassword(request: NextRequest) {
  if (!isSameOriginAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL)) {
    return json({ error: "Request origin is not allowed." }, 403);
  }
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return json({ error: "Password updates are not configured." }, 503);
  let input: Record<string, unknown>;
  try {
    const body = await readJsonBody(request, 8 * 1024, 5_000);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["mode", "username", "currentPassword", "newPassword", "confirmPassword", "otp", "csrfToken"].includes(key))) {
      return json({ error: "Password update request is invalid." }, 400);
    }
    input = body as Record<string, unknown>;
  } catch (error) {
    return json({ error: error instanceof RequestBodyError ? error.message : "Password update request is invalid." },
      error instanceof RequestBodyError ? error.status : 400);
  }
  if (!csrfVerified(request, input.csrfToken, secret)) return json({ error: "Refresh the page and try again." }, 403);
  if ((input.mode !== "setup" && input.mode !== "change") || typeof input.username !== "string" ||
      !input.username.trim() || input.username.length > 254 || /[\u0000-\u001f\u007f]/.test(input.username) ||
      typeof input.currentPassword !== "string" || !input.currentPassword || input.currentPassword.length > 128 ||
      typeof input.newPassword !== "string" || !input.newPassword || input.newPassword.length > 128 ||
      input.newPassword !== input.confirmPassword || input.newPassword === input.currentPassword ||
      (input.otp !== undefined && (typeof input.otp !== "string" || (input.otp !== "" && !/^\d{6,8}$/.test(input.otp))))) {
    return json({ error: "Enter your current password and matching new passwords of up to 128 characters. The new password must be different." }, 400);
  }
  const session = await apiSession();
  if (request.cookies.has(USER_MANAGEMENT_STEP_UP_COOKIE)) {
    return json({ error: "Finish or cancel administrator re-authentication before updating a password." }, 409);
  }
  if (input.mode === "setup" && request.cookies.getAll().some(({ name }) =>
    /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name))) {
    return json({ error: "Sign out before completing another account's temporary-password setup." }, 409);
  }
  if (input.mode === "change" && (!session?.subject || !session.access_token || session.error)) {
    return json({ error: "Sign in before changing your password." }, 401);
  }
  const issuer = process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret || !process.env.PASSWORD_UPDATE_LOCK_API_URL) {
    return json({ error: "Password updates are not configured. Contact your administrator." }, 503);
  }
  try {
    const deadline = AbortSignal.timeout(35_000);
    await updateKeycloakPassword({ mode: input.mode, username: input.username, currentPassword: input.currentPassword,
      newPassword: input.newPassword, otp: input.otp as string | undefined,
      expectedSubject: input.mode === "change" ? session!.subject : undefined }, {
      issuer, jwksIssuer: process.env.KEYCLOAK_JWKS_BASE, clientId, clientSecret,
    }, { withUserLock, fetcher: (url, init) => fetch(url, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline }) });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof PasswordUpdateError || error instanceof LeaseError) return json({ error: error.message }, error.status);
    console.error("[password-update] Request could not be completed.");
    return json({ error: "Password updates are temporarily unavailable. Please try again later." }, 503);
  }
}

export const POST = withApiSession(updatePassword);
