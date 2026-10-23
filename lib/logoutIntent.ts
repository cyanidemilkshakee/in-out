import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const LOGOUT_INTENT_COOKIE = "inout_logout_intent";
const PURPOSE = "inout:logout-intent:v1.";

export function createLogoutIntent(secret: string, now = Date.now()) {
  if (!secret) throw new Error("Authentication is not configured.");
  const nonce = randomUUID();
  const payload = Buffer.from(JSON.stringify({ nonce, issuedAt: now })).toString("base64url");
  const signature = createHmac("sha256", secret).update(PURPOSE + payload).digest("base64url");
  return { nonce, cookie: `${payload}.${signature}` };
}

export function validLogoutIntent(value: string | undefined, nonce: string | null, secret: string | undefined, now = Date.now()): boolean {
  if (!value || !nonce || !secret || value.length > 512) return false;
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    const [payload, signature] = parts;
    const expected = createHmac("sha256", secret).update(PURPOSE + payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const intent = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return intent && typeof intent === "object" && Object.keys(intent).length === 2 &&
      typeof intent.nonce === "string" && intent.nonce === nonce &&
      Number.isSafeInteger(intent.issuedAt) && intent.issuedAt <= now + 30_000 && intent.issuedAt > now - 5 * 60_000;
  } catch { return false; }
}
