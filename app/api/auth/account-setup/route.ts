import { NextResponse } from "next/server";
import { boundedIdentityResponse } from "../../../../lib/keycloakTokenValidation";
import { isSameOriginAuthRequest } from "../../../../lib/authRequestBoundary";
import { readJsonBody, RequestBodyError } from "../../../../lib/requestJson";
import { isPasswordValid, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE } from "../../../../lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IdentityUser = {
  id?: unknown;
  username?: unknown;
  email?: unknown;
  enabled?: unknown;
  requiredActions?: unknown;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

function identityConfig() {
  const issuer = (process.env.KEYCLOAK_JWKS_BASE || process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER || "").replace(/\/+$/, "");
  const marker = "/realms/";
  const markerIndex = issuer.indexOf(marker);
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  const setupClientId = process.env.KEYCLOAK_ACCOUNT_SETUP_CLIENT_ID;
  const setupClientSecret = process.env.KEYCLOAK_ACCOUNT_SETUP_CLIENT_SECRET;
  if (!issuer || markerIndex < 1 || !clientId || !clientSecret || !setupClientId || !setupClientSecret) return null;
  const realm = issuer.slice(markerIndex + marker.length);
  if (!realm || realm.includes("/")) return null;
  return { issuer, base: issuer.slice(0, markerIndex), realm, clientId, clientSecret, setupClientId, setupClientSecret };
}

async function readProviderJson(response: Response) {
  return await response.json().catch(() => null) as Record<string, unknown> | null;
}

async function providerRequest(url: string, init: RequestInit) {
  return boundedIdentityResponse(await fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }));
}

async function findSetupUser(config: NonNullable<ReturnType<typeof identityConfig>>, username: string, token: string) {
  const exactSearch = async (key: "username" | "email") => {
    const url = new URL(`${config.base}/admin/realms/${encodeURIComponent(config.realm)}/users`);
    url.searchParams.set(key, username);
    url.searchParams.set("exact", "true");
    const response = await providerRequest(url.href, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Identity administration is unavailable.");
    const users = await readProviderJson(response);
    if (!Array.isArray(users)) throw new Error("Identity administration returned an invalid response.");
    return users.filter((user): user is IdentityUser => !!user && typeof user === "object")
      .filter(user => typeof user.id === "string" &&
        (key === "username" ? typeof user.username === "string" && user.username.toLowerCase() === username.toLowerCase()
          : typeof user.email === "string" && user.email.toLowerCase() === username.toLowerCase()));
  };
  const byUsername = await exactSearch("username");
  if (byUsername.length === 1) return byUsername[0];
  if (byUsername.length > 1) return null;
  const byEmail = await exactSearch("email");
  return byEmail.length === 1 ? byEmail[0] : null;
}

async function startSetupClientSession(config: NonNullable<ReturnType<typeof identityConfig>>) {
  const response = await providerRequest(`${config.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.setupClientId,
      client_secret: config.setupClientSecret,
    }),
  });
  const payload = await readProviderJson(response);
  if (!response.ok || typeof payload?.access_token !== "string") throw new Error("Account setup is unavailable.");
  return payload.access_token;
}

async function completeAccountSetup(request: Request) {
  if (!isSameOriginAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL)) {
    return jsonError("Request origin is not allowed.", 403);
  }
  const config = identityConfig();
  if (!config) return jsonError("App-managed account setup is not configured. Contact your administrator.", 503);

  let body: unknown;
  try {
    body = await readJsonBody(request, 8 * 1024, 5_000);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request.", error instanceof RequestBodyError ? error.status : 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["username", "currentPassword", "otp", "newPassword"].includes(key))) {
    return jsonError("Account setup request is invalid.", 400);
  }
  const input = body as Record<string, unknown>;
  const username = input.username;
  const currentPassword = input.currentPassword;
  const otp = input.otp;
  const newPassword = input.newPassword;
  if (typeof username !== "string" || !username.trim() || username.length > 254 || /[\u0000-\u001f\u007f]/.test(username) ||
      typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 128 ||
      (otp !== undefined && (typeof otp !== "string" || (otp !== "" && !/^\d{6,8}$/.test(otp)))) ||
      typeof newPassword !== "string" || Array.from(newPassword).length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(newPassword) || newPassword === currentPassword) {
    return jsonError(`Enter your current password and a different new password. ${PASSWORD_POLICY_MESSAGE}`, 400);
  }
  if (!isPasswordValid(newPassword)) return jsonError(PASSWORD_POLICY_MESSAGE, 400);

  try {
    const body = new URLSearchParams({
      grant_type: "password", client_id: config.clientId, client_secret: config.clientSecret,
      username: username.trim(), password: currentPassword, scope: "openid profile email",
    });
    if (otp) body.set("totp", otp);
    const verification = await providerRequest(`${config.issuer}/protocol/openid-connect/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (verification.ok) return jsonError("This account is ready. Sign in with your current password.", 409);
    const verificationBody = await readProviderJson(verification);
    if (verification.status !== 400 || verificationBody?.error !== "invalid_grant" ||
        verificationBody?.error_description !== "Account is not fully set up") {
      return jsonError("The current password could not be verified.", 401);
    }

    const serviceToken = await startSetupClientSession(config);
    const user = await findSetupUser(config, username.trim(), serviceToken);
    if (!user || typeof user.id !== "string" || user.enabled !== true || !Array.isArray(user.requiredActions) ||
        !user.requiredActions.includes("UPDATE_PASSWORD")) {
      return jsonError("This account needs administrator help to complete its security setup.", 409);
    }
    if (user.requiredActions.some(action => action !== "UPDATE_PASSWORD")) {
      return jsonError("This account has additional security setup. Contact your administrator.", 409);
    }

    const userEndpoint = `${config.base}/admin/realms/${encodeURIComponent(config.realm)}/users/${encodeURIComponent(user.id)}`;
    const resetPassword = (password: string, temporary: boolean) => providerRequest(`${userEndpoint}/reset-password`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "password", value: password, temporary }),
    });
    const updateRequiredActions = (requiredActions: string[]) => providerRequest(userEndpoint, {
      method: "PUT",
      headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requiredActions }),
    });

    const passwordUpdated = await resetPassword(newPassword, false);
    if (!passwordUpdated.ok) return jsonError("The new password does not meet the account's security requirements.", 400);
    const actionUpdated = await updateRequiredActions([]);
    if (!actionUpdated.ok) {
      // Restore the verified temporary credential if clearing the sole
      // password-update action failed, so the user can retry safely.
      await resetPassword(currentPassword, true).catch(() => null);
      return jsonError("Account setup could not be completed. Please try again or contact your administrator.", 503);
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return jsonError("Account setup is temporarily unavailable. Please try again.", 503);
  }
}

export const POST = completeAccountSetup;
