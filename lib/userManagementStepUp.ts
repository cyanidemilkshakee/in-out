export const USER_MANAGEMENT_STEP_UP_COOKIE = "inout_user_management_step_up";
export const USER_MANAGEMENT_STEP_UP_LOCK_COOKIE = "inout_user_management_step_up_lock";
export const USER_MANAGEMENT_STEP_UP_DURATIONS = [5, 10, 15, 20, 30, 60] as const;
export const DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES = 5;
export type StepUpDurationMinutes = typeof USER_MANAGEMENT_STEP_UP_DURATIONS[number];
export type StepUpIntent = { issuedAt: number; durationMinutes: StepUpDurationMinutes; baseExpiresAt?: number };
const INTENT_PURPOSE = "inout:user-management-intent:v1.";
const PROOF_PURPOSE = "inout:user-management-step-up:v1.";

export function formatStepUpCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const minuteSecondClock = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${minuteSecondClock}` : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function isStepUpDurationMinutes(value: unknown): value is StepUpDurationMinutes {
  return typeof value === "number" && USER_MANAGEMENT_STEP_UP_DURATIONS.some((minutes) => minutes === value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signStepUpIntent(issuedAt: number, secret: string, durationMinutes: StepUpDurationMinutes = DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, baseExpiresAt?: number): Promise<string> {
  if (!Number.isSafeInteger(issuedAt) || !isStepUpDurationMinutes(durationMinutes) ||
      (baseExpiresAt !== undefined && (!Number.isSafeInteger(baseExpiresAt) || baseExpiresAt <= 0))) {
    throw new Error("Invalid re-authentication window.");
  }
  const intent: StepUpIntent = { issuedAt, durationMinutes, ...(baseExpiresAt === undefined ? {} : { baseExpiresAt }) };
  const value = base64Url(new TextEncoder().encode(JSON.stringify(intent)));
  return `${value}.${base64Url(await hmac(INTENT_PURPOSE + value, secret))}`;
}

export async function verifyStepUpIntent(value: string | undefined, secret: string, now = Date.now()): Promise<StepUpIntent | null> {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = value.slice(0, separator);
  const suppliedSignature = fromBase64Url(value.slice(separator + 1));
  if (!suppliedSignature) return null;
  const expectedSignature = await hmac(INTENT_PURPOSE + payload, secret);
  let difference = suppliedSignature.length ^ expectedSignature.length;
  for (let index = 0; index < Math.max(suppliedSignature.length, expectedSignature.length); index++) {
    difference |= (suppliedSignature[index] ?? 0) ^ (expectedSignature[index] ?? 0);
  }
  if (difference !== 0) return null;
  try {
    const bytes = fromBase64Url(payload);
    if (!bytes) return null;
    const intent = JSON.parse(new TextDecoder().decode(bytes));
    if (!intent || typeof intent !== "object" ||
        (Object.keys(intent).length !== 2 && Object.keys(intent).length !== 3) ||
        !Number.isSafeInteger(intent.issuedAt) || !isStepUpDurationMinutes(intent.durationMinutes) ||
        (Object.prototype.hasOwnProperty.call(intent, "baseExpiresAt") && (!Number.isSafeInteger(intent.baseExpiresAt) || intent.baseExpiresAt <= 0)) ||
        Object.keys(intent).some((key) => !["issuedAt", "durationMinutes", "baseExpiresAt"].includes(key))) return null;
    return intent.issuedAt > now - 10 * 60_000 && intent.issuedAt <= now + 30_000 ? intent : null;
  } catch {
    return null;
  }
}

export function completedStepUpWindow(intent: StepUpIntent, authTime: unknown, now = Date.now()) {
  // The verified ID token must represent a fresh login after this unlock intent.
  if (typeof authTime !== "number" || !Number.isSafeInteger(authTime) || authTime <= 0 ||
      authTime * 1_000 < intent.issuedAt - 5_000 || authTime * 1_000 > now + 30_000 ||
      !isStepUpDurationMinutes(intent.durationMinutes) ||
      (intent.baseExpiresAt !== undefined && (!Number.isSafeInteger(intent.baseExpiresAt) || intent.baseExpiresAt <= 0))) return undefined;
  // For an active window, the signed intent captures its old expiry. Add the
  // chosen duration to that exact expiry, including time spent in the sign-in
  // redirect. A locked/new window has no base expiry and starts at auth_time.
  const extensionSeconds = intent.baseExpiresAt === undefined ? 0 : intent.baseExpiresAt - authTime;
  const expiresAt = authTime + extensionSeconds + intent.durationMinutes * 60;
  return Number.isSafeInteger(expiresAt) && now / 1_000 < expiresAt
    ? { expiresAt, durationMinutes: intent.durationMinutes, extensionSeconds }
    : undefined;
}

type StepUpSessionFields = { authTime?: unknown; stepUpExpiresAt?: unknown; stepUpDurationMinutes?: unknown; stepUpExtensionSeconds?: unknown };

export function isActiveUserManagementStepUp(session: StepUpSessionFields, now = Date.now()): boolean {
  const { authTime, stepUpExpiresAt, stepUpDurationMinutes } = session;
  const stepUpExtensionSeconds = session.stepUpExtensionSeconds ?? 0;
  return typeof authTime === "number" && Number.isSafeInteger(authTime) && authTime > 0 &&
    authTime <= now / 1_000 + 30 && isStepUpDurationMinutes(stepUpDurationMinutes) &&
    typeof stepUpExtensionSeconds === "number" && Number.isSafeInteger(stepUpExtensionSeconds) &&
    typeof stepUpExpiresAt === "number" && Number.isSafeInteger(stepUpExpiresAt) &&
    stepUpExpiresAt === authTime + stepUpDurationMinutes * 60 + stepUpExtensionSeconds && now / 1_000 < stepUpExpiresAt;
}

export function userManagementStepUpLockMaxAge(session: StepUpSessionFields, now = Date.now()): number {
  const expiresAt = session.stepUpExpiresAt;
  const remaining = typeof expiresAt === "number" && isActiveUserManagementStepUp(session, now)
    ? Math.max(0, Math.ceil(expiresAt - now / 1_000))
    : 0;
  // A canceled sign-in must not let the previous step-up window become active
  // again when its lock cookie expires.
  return Math.max(60 * 60 + 30, remaining + 30);
}

// Called only by the server BFF. The secret and proof never enter a public session.
export async function signStepUpProof(session: StepUpSessionFields, accessToken: string, secret: string, now = Date.now()): Promise<string> {
  if (!secret || !accessToken || !isActiveUserManagementStepUp(session, now)) throw new Error("Fresh re-authentication is required to manage users.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)));
  const tokenHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const value = base64Url(new TextEncoder().encode(JSON.stringify({
    issuedAt: Math.floor(now / 1_000), authTime: session.authTime, expiresAt: session.stepUpExpiresAt,
    durationMinutes: session.stepUpDurationMinutes, tokenHash,
  })));
  return `${value}.${base64Url(await hmac(PROOF_PURPOSE + value, secret))}`;
}

export function isSuccessfulUserManagementCallback(location: string, requestUrl: string, setCookies: string[], authUrl?: string): boolean {
  try {
    const trustedOrigin = new URL(authUrl || requestUrl).origin;
    const destination = new URL(location, authUrl || requestUrl);
    if (destination.origin !== trustedOrigin || destination.pathname !== "/admin/users" || destination.searchParams.has("error")) return false;
    // Failed/canceled OAuth callbacks can redirect to /login while retaining
    // the old session. Only a newly issued session can finish this unlock.
    return setCookies.some((cookie) => /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=[^;]+;/.test(cookie) && !/;\s*Max-Age=0(?:;|$)/i.test(cookie));
  } catch {
    return false;
  }
}
