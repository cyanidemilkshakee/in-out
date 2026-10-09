import type { NextRequest } from "next/server";
import { handlers } from "../../../../auth";
import { isSuccessfulUserManagementCallback, USER_MANAGEMENT_STEP_UP_COOKIE, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../../lib/userManagementStepUp";

function secureCookie(request: NextRequest) {
  try {
    return new URL(process.env.AUTH_URL || request.url).protocol === "https:";
  } catch {
    return request.nextUrl.protocol === "https:";
  }
}

export async function GET(request: NextRequest) {
  const response = await handlers.GET(request);
  const callbackPath = "/api/auth/callback/keycloak";
  if (
    request.nextUrl.pathname !== callbackPath ||
    !request.cookies.has(USER_MANAGEMENT_STEP_UP_COOKIE) ||
    response.status < 300 ||
    response.status >= 400
  ) {
    return response;
  }

  const location = response.headers.get("location");
  if (!location || !isSuccessfulUserManagementCallback(location, request.url, response.headers.getSetCookie(), process.env.AUTH_URL)) return response;

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

export const POST = handlers.POST;
