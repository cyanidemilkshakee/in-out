import { NextRequest, NextResponse } from "next/server";
import { decode } from "next-auth/jwt";
import { handlers } from "../../../../auth";
import { isSuccessfulUserManagementCallback, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE, verifyStepUpIntent } from "../../../../lib/userManagementStepUp";
import { AuthRequestError, prepareAuthRequest, publicAuthSession, safeAuthResponseUrl } from "../../../../lib/authRequestBoundary";
import { issuedAuthSession, isCompletedAdminStepUpToken } from "../../../../lib/authCallbackSession";

const appAuthErrorCodes = new Set([
  "AccessDenied", "AccountNotLinked", "AdapterError", "CallbackRouteError", "Configuration", "CredentialsSignin",
  "DuplicateConditionalUI", "EmailSignInError", "ErrorPageLoop", "EventError", "ExperimentalFeatureNotEnabled",
  "identity_provider_failure", "InvalidCallbackUrl", "InvalidCheck", "InvalidEndpoints", "InvalidProvider",
  "JWTSessionError", "MissingAdapter", "MissingAdapterMethods", "MissingAuthorize", "MissingCSRF", "MissingSecret",
  "MissingWebAuthnAutocomplete", "OAuthAccountNotLinked", "OAuthCallback", "OAuthCallbackError", "OAuthProfileParseError",
  "OAuthSignin", "OAuthSignInError", "SessionTokenError", "SignOutError", "UnknownAction", "UntrustedHost",
  "UnsupportedStrategy", "Verification", "WebAuthnVerificationError",
]);

function appAuthErrorCode(value: string | null) {
  return value && appAuthErrorCodes.has(value) ? value : "auth_failed";
}

function secureCookie(request: NextRequest) {
  try {
    return new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).protocol === "https:";
  } catch {
    return request.nextUrl.protocol === "https:";
  }
}

async function requestSessionToken(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cookies = request.cookies.getAll().map(({ name, value }) => `${name}=${value};`);
  const issued = issuedAuthSession(cookies, secureCookie(request));
  if (!issued) return null;
  try { return await decode({ token: issued.value, secret, salt: issued.salt }); }
  catch { return null; }
}

function localRedirect(request: NextRequest, path: string, origin: string) {
  const destination = new URL(path, origin).href;
  if (request.method === "POST" && request.headers.get("x-auth-return-redirect") === "1") {
    return publicJson({ url: destination });
  }
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function recordBrowserSso(request: NextRequest, response: Response) {
  if (!["/api/auth/callback/keycloak", "/api/auth/callback/keycloak-password-setup", "/api/auth/callback/keycloak-password-change"].includes(request.nextUrl.pathname) || response.status < 200 || response.status >= 400) return response;
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

async function preserveSessionForPasswordChange(request: NextRequest, response: Response, origin: string) {
  if (request.nextUrl.pathname !== "/api/auth/callback/keycloak-password-change" || response.status < 200 || response.status >= 400) return response;
  const cookies = response.headers.getSetCookie();
  const issued = issuedAuthSession(cookies, secureCookie(request));
  const actionStatus = request.nextUrl.searchParams.get("kc_action_status");
  if (!issued && actionStatus !== "cancelled" && actionStatus !== "success") return response;

  let returnedSubject: string | null = null;
  if (issued) {
    try {
      const decoded = await decode({ token: issued.value, secret: process.env.AUTH_SECRET!, salt: issued.salt });
      if (decoded && typeof decoded === "object" && "sub" in decoded && typeof decoded.sub === "string") {
        returnedSubject = decoded.sub;
      }
    }
    catch { /* Treat an unreadable new session as an unconfirmed action. */ }
  }
  const currentToken = await requestSessionToken(request);
  const currentSubject = typeof currentToken?.sub === "string" ? currentToken.sub : null;
  const action = request.nextUrl.searchParams.get("kc_action");
  const reason = actionStatus === "cancelled" ? "cancelled"
    : action !== "UPDATE_PASSWORD" || actionStatus !== "success" ? "unconfirmed"
    : !currentSubject ? "session_expired"
    : !returnedSubject ? "unconfirmed"
    : returnedSubject !== currentSubject ? "identity_mismatch"
    : null;
  if (!reason) return response;

  // Keep the existing account's encrypted session cookie. Auth.js has already
  // validated OAuth state and cleared the one-time callback cookies.
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    const name = cookie.slice(0, cookie.indexOf("="));
    if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)) continue;
    headers.append("set-cookie", cookie);
  }
  const destination = reason === "session_expired"
    ? "/login?from=%2Faccount&error=password_change_signin_required"
    : `/account?passwordChange=${reason === "cancelled" ? "cancelled" : reason === "identity_mismatch" ? "identity_mismatch" : "unconfirmed"}`;
  headers.set("Location", new URL(destination, origin).href);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.delete("Content-Length");
  return new Response(null, { status: 303, headers });
}

async function requireSuccessfulPasswordSetup(request: NextRequest, response: Response, origin: string) {
  if (request.nextUrl.pathname !== "/api/auth/callback/keycloak-password-setup" || response.status < 200 || response.status >= 400) return response;
  const action = request.nextUrl.searchParams.get("kc_action");
  const actionStatus = request.nextUrl.searchParams.get("kc_action_status");
  if (action === "UPDATE_PASSWORD" && actionStatus === "success") return response;

  // Do not establish an application session unless Keycloak confirms the
  // temporary password action completed. Keep Auth.js's callback-cookie
  // cleanup, but discard any session cookie minted from an incomplete action.
  const headers = new Headers(response.headers);
  const cookies = response.headers.getSetCookie();
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    const name = cookie.slice(0, cookie.indexOf("="));
    if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)) continue;
    headers.append("set-cookie", cookie);
  }
  const error = actionStatus === "cancelled" ? "password_setup_cancelled" : "password_setup_unconfirmed";
  headers.set("Location", new URL(`/login?error=${error}`, origin).href);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.delete("Content-Length");
  return new Response(null, { status: 303, headers });
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
    if (request.nextUrl.pathname === "/api/auth/error") {
      const error = request.nextUrl.searchParams.get("error");
      return localRedirect(request, `/login?error=${appAuthErrorCode(error)}`, origin);
    }
    if (["/api/auth/callback/keycloak", "/api/auth/callback/keycloak-password-change"].includes(request.nextUrl.pathname)) {
      return localRedirect(request, "/login?error=OAuthCallbackError", origin);
    }
    if (request.nextUrl.pathname === "/api/auth/callback/keycloak-password-setup") {
      const headers = responseHeaders(response);
      const cookies = response.headers.getSetCookie();
      headers.delete("set-cookie");
      for (const cookie of cookies) {
        const name = cookie.slice(0, cookie.indexOf("="));
        if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)) continue;
        headers.append("set-cookie", cookie);
      }
      headers.set("Location", new URL("/login?error=password_setup_unconfirmed", origin).href);
      return new Response(null, { status: 303, headers });
    }
    const sanitized = publicJson({ error: "Authentication could not be completed." }, response);
    sanitized.headers.delete("Location");
    return sanitized;
  }
  if (request.nextUrl.pathname === "/api/auth/session") {
    return publicJson(publicAuthSession(await response.json()), response);
  }
  const providerIssuer = process.env.KEYCLOAK_ISSUER_PUBLIC || process.env.KEYCLOAK_ISSUER;
  const authorizationUrl = ["/api/auth/signin/keycloak", "/api/auth/signin/keycloak-password-setup", "/api/auth/signin/keycloak-password-change"].includes(request.nextUrl.pathname) && providerIssuer
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
    const path = request.nextUrl.pathname;
    if (method === "GET" && path === "/api/auth/signin/keycloak-password-setup") {
      return localRedirect(request, "/login?error=password_setup_use_login", boundary.origin);
    }
    if (method === "GET" && path === "/api/auth/signin/keycloak-password-change") {
      return localRedirect(request, "/account", boundary.origin);
    }
    if (method === "GET" && path === "/api/auth/signin/keycloak") {
      return localRedirect(request, "/login?error=signin_use_login", boundary.origin);
    }
    if (request.nextUrl.pathname === "/api/auth/signin/keycloak-password-setup") {
      const hasAppSession = request.cookies.getAll().some(({ name }) =>
        /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name));
      if (hasAppSession || request.cookies.has(USER_MANAGEMENT_STEP_UP_COOKIE)) {
        return localRedirect(request, "/login?error=password_setup_signout_required", boundary.origin);
      }
    }
    if (request.nextUrl.pathname === "/api/auth/signin/keycloak-password-change") {
      const session = await requestSessionToken(request);
      if (!session?.sub || session.error) return localRedirect(request, "/login?from=%2Faccount&error=password_change_signin_required", boundary.origin);
      if (request.cookies.has(USER_MANAGEMENT_STEP_UP_COOKIE)) return localRedirect(request, "/account?passwordChange=stepup_locked", boundary.origin);
    }
    const boundedRequest = boundary.body === undefined ? request : new NextRequest(request.url, {
      method, headers: request.headers, body: boundary.body, signal: request.signal,
    });
    const authResponse = await publicResponse(boundedRequest, await handlers[method](boundedRequest), boundary.origin);
    const setupSafeResponse = await requireSuccessfulPasswordSetup(boundedRequest, authResponse, boundary.origin);
    const withBrowserSso = await recordBrowserSso(boundedRequest, setupSafeResponse);
    const accountSafeResponse = await preserveSessionForPasswordChange(boundedRequest, withBrowserSso, boundary.origin);
    return clearStepUpAfterSignIn(boundedRequest, accountSafeResponse);
  } catch (error) {
    return publicJson({ error: error instanceof AuthRequestError ? error.message : "Authentication could not be completed." },
      undefined, error instanceof AuthRequestError ? error.status : 500);
  }
}

export const GET = (request: NextRequest) => handleAuth(request, "GET");
export const POST = (request: NextRequest) => handleAuth(request, "POST");
