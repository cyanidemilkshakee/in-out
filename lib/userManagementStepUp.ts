export const USER_MANAGEMENT_STEP_UP_COOKIE = "inout_user_management_step_up";
export const USER_MANAGEMENT_STEP_UP_LOCK_COOKIE = "inout_user_management_step_up_lock";

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

export async function signStepUpIntent(issuedAt: number, secret: string): Promise<string> {
  const value = String(issuedAt);
  return `${value}.${base64Url(await hmac(value, secret))}`;
}

export async function verifyStepUpIntent(value: string | undefined, secret: string, now = Date.now()): Promise<number | null> {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const issuedAt = Number(value.slice(0, separator));
  const suppliedSignature = fromBase64Url(value.slice(separator + 1));
  if (!Number.isInteger(issuedAt) || !suppliedSignature) return null;
  const expectedSignature = await hmac(String(issuedAt), secret);
  let difference = suppliedSignature.length ^ expectedSignature.length;
  for (let index = 0; index < Math.max(suppliedSignature.length, expectedSignature.length); index++) {
    difference |= (suppliedSignature[index] ?? 0) ^ (expectedSignature[index] ?? 0);
  }
  if (difference !== 0) return null;
  return issuedAt > now - 10 * 60_000 && issuedAt <= now + 30_000 ? issuedAt : null;
}
