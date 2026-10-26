import { NextRequest } from "next/server";
import { decode } from "next-auth/jwt";
import { handlers } from "../../../../auth";
import { isSuccessfulUserManagementCallback, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, verifyStepUpIntent } from "../../../../lib/userManagementStepUp";
import { AuthRequestError, prepareAuthRequest, publicAuthSession, safeAuthResponseUrl } from "../../../../lib/authRequestBoundary";
import { issuedAuthSession, isCompletedAdminStepUpToken } from "../../../../lib/authCallbackSession";

function secureCookie(request: NextRequest) {
  try {
    return new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).protocol === "https:";
  } catch {
    return request.nextUrl.protocol === "https:";
  }
}

async function recordBrowserSso(request: NextRequest, response: Response) {
  if (request.nextUrl.pathname !== "/api/auth/callback/keycloak" || response.status < 200 || response.status >= 400) return response;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return response;
  try {
    // A successful setup callback creates browser SSO even if a subsequent
    // password reauthentication changes the app session's provider. Only an
    // actually issued, decrypted session may record that logout obligation.
    const issued = issuedAuthSession(response.headers.getSetCookie(), secureCookie(request));
    if (!issued) return response;
    const token = await decode({ token: issued.value, secret, salt: issued.salt });
    if (!token || token.provider !== "keycloak" || token.error || typeof token.access_token !== "string" ||
        !token.access_token || typeof token.expires_at !== "number" || token.expires_at <= Date.now() / 1000) return response;
    const secure = secureCookie(request) ? "; Secure" : "";
    response.headers.append("Set-Cookie", `inout_browser_sso=1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`);
  } catch {
    // Failed, incomplete, and malformed callbacks must not create SSO state.
  }
  return response;
}

async function clearStepUpAfterSignIn(request: NextRequest, response: Response) {
  const callbackPaths = ["/api/auth/callback/keycloak", "/api/auth/callback/credentials"];
  if (
    !callbackPaths.includes(request.nextUrl.pathname) ||
    !request.cookies.has(USER_MANAGEMENT_STEP_UP_COOKIE) ||
    response.status < 200 ||
    response.status >= 400
  ) {
    return response;
  }

  let location = response.headers.get("location");
  if (!location && request.method === "POST") {
    try {
      const body = await response.clone().json() as { url?: unknown };
      location = typeof body.url === "string" ? body.url : null;
    } catch {
      return response;
    }
  }
  if (!location || !isSuccessfulUserManagementCallback(location, request.url, response.headers.getSetCookie(), process.env.AUTH_URL || process.env.NEXTAUTH_URL)) return response;

  const secret = process.env.AUTH_SECRET;
  if (!secret) return response;
  try {
    const intent = await verifyStepUpIntent(request.cookies.get(USER_MANAGEMENT_STEP_UP_COOKIE)?.value, secret);
    const issued = issuedAuthSession(response.headers.getSetCookie(), secureCookie(request));
    if (!intent || !issued) return response;
    const token = await decode({ token: issued.value, secret, salt: issued.salt });
    if (!isCompletedAdminStepUpToken(token, intent)) return response;
  } catch {
    // Invalid/old/partial sessions retain the lock and never enter error output.
    return response;
  }

  const secure = secureCookie(request) ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${USER_MANAGEMENT_STEP_UP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
  );
  response.headers.append(
    "Set-Cookie",
    `${USER_MANAGEMENT_STEP_UP_LOCK_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
  );
  return response;
}

function responseHeaders(response?: Response) {
  const headers = new Headers(response?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.delete("Content-Length");
  return headers;
}

function publicJson(value: unknown, response?: Response, status = response?.status ?? 200) {
  const headers = responseHeaders(response);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

async function publicResponse(request: NextRequest, response: Response, origin: string) {
  if (response.status >= 400) {
    const sanitized = publicJson({ error: "Authentication could not be completed." }, response);
    sanitized.headers.delete("Location");
    return sanitized;
  }
  if (request.nextUrl.pathname === "/api/auth/session") {
    return publicJson(publicAuthSession(await response.json()), response);
  }
  const providerIssuer = process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER;
  const authorizationUrl = request.nextUrl.pathname === "/api/auth/signin/keycloak" && providerIssuer
    ? `${providerIssuer.replace(/\/$/, "")}/protocol/openid-connect/auth`
    : undefined;
  const location = response.headers.get("location");
  if (location) {
    const headers = responseHeaders(response);
    headers.set("Location", safeAuthResponseUrl(location, origin, authorizationUrl));
    return new Response(response.body, { status: response.status, headers });
  }
  if (request.method === "POST" && request.headers.get("x-auth-return-redirect") === "1") {
    const body: unknown = await response.json();
    const url = body && typeof body === "object" && "url" in body ? body.url : undefined;
    if (typeof url !== "string") throw new AuthRequestError("Authentication response is invalid.", 502);
    // Auth.js returns only a destination to browser sign-in/sign-out callers.
    // Explicit construction prevents provider response fields being exposed.
    return publicJson({ url: safeAuthResponseUrl(url, origin, authorizationUrl) }, response);
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders(response) });
}

async function handleAuth(request: NextRequest, method: "GET" | "POST") {
  try {
    const boundary = await prepareAuthRequest(request, process.env.AUTH_URL || process.env.NEXTAUTH_URL);
    const boundedRequest = boundary.body === undefined ? request : new NextRequest(request.url, {
      method, headers: request.headers, body: boundary.body, signal: request.signal,
    });
    const response = await publicResponse(boundedRequest, await handlers[method](boundedRequest), boundary.origin);
    return clearStepUpAfterSignIn(boundedRequest, await recordBrowserSso(boundedRequest, response));
  } catch (error) {
    return publicJson({ error: error instanceof AuthRequestError ? error.message : "Authentication could not be completed." },
      undefined, error instanceof AuthRequestError ? error.status : 500);
  }
}

export const GET = (request: NextRequest) => handleAuth(request, "GET");
export const POST = (request: NextRequest) => handleAuth(request, "POST");
