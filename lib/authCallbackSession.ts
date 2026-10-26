import { rolesFromAccessToken, subjectFromAccessToken } from "./keycloakSession";
import { completedStepUpWindow, isStepUpWindowId, type StepUpIntent } from "./userManagementStepUp";
import { hasAdminAccess } from "./applicationRoles";

const CHUNK_SIZE = 3936;
const MAX_SESSION_BYTES = 32 * 1024;

/** Reconstruct only session bytes actually issued by this response, never old request chunks. */
export function issuedAuthSession(cookies: string[], secure: boolean): { value: string; salt: string } | null {
  const salt = `${secure ? '__Secure-' : ''}authjs.session-token`;
  const chunks = new Map<number, string>();
  let unchunked: string | undefined;
  let total = 0;
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    const name = cookie.slice(0, separator);
    if (name !== salt && !name.startsWith(`${salt}.`)) continue;
    const value = cookie.slice(separator + 1).split(';', 1)[0];
    const removed = !value || /;\s*Max-Age=0(?:;|$)/i.test(cookie);
    const suffix = name === salt ? undefined : name.slice(salt.length + 1);
    if (suffix !== undefined && !/^(0|[1-9]\d?)$/.test(suffix)) return null;
    const index = suffix === undefined ? undefined : Number(suffix);
    if (index !== undefined && index > Math.ceil(MAX_SESSION_BYTES / CHUNK_SIZE)) return null;
    if (index === undefined) {
      total -= unchunked?.length ?? 0;
      unchunked = removed ? undefined : value;
    } else {
      total -= chunks.get(index)?.length ?? 0;
      if (removed) chunks.delete(index); else chunks.set(index, value);
    }
    if (!removed) {
      if (value.length > CHUNK_SIZE || !/^[A-Za-z0-9._-]+$/.test(value)) return null;
      total += value.length;
    }
    if (total > MAX_SESSION_BYTES) return null;
  }
  if (unchunked !== undefined) return chunks.size ? null : { value: unchunked, salt };
  if (!chunks.size) return null;
  const values: string[] = [];
  for (let index = 0; index < chunks.size; index++) {
    const value = chunks.get(index);
    if (!value || (index < chunks.size - 1 && value.length !== CHUNK_SIZE)) return null;
    values.push(value);
  }
  return { value: values.join(''), salt };
}

/** Reauthentication must prove the same administrator identity that requested the step-up. */
export function matchesAdminStepUpIdentity(intent: StepUpIntent | null, subject: unknown, roles: unknown): boolean {
  return !!intent && typeof subject === "string" && subject === intent.subject && hasAdminAccess(roles);
}

/** A destination/cookie alone cannot prove that this admin's unlock intent completed. */
export function isCompletedAdminStepUpToken(token: Record<string, unknown> | null, intent: StepUpIntent, now = Date.now()): boolean {
  if (!token || token.error || token.sub !== intent.subject || token.step_up_intent_id !== intent.intentId ||
      typeof token.access_token !== 'string' || subjectFromAccessToken(token.access_token) !== intent.subject ||
      !hasAdminAccess(token.roles) || !hasAdminAccess(rolesFromAccessToken(token.access_token)) ||
      typeof token.expires_at !== 'number' || !Number.isFinite(token.expires_at) || token.expires_at <= now / 1000 ||
      !isStepUpWindowId(token.step_up_window_id)) return false;
  const expected = completedStepUpWindow(intent, token.auth_time, intent.subject, now);
  return !!expected && token.step_up_expires_at === expected.expiresAt &&
    token.step_up_duration_minutes === expected.durationMinutes && token.step_up_extension_seconds === expected.extensionSeconds;
}
