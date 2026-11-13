import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../authSession";
import { callPythonApi, PythonApiError } from "../pythonApi";
import { readJsonBody, RequestBodyError } from "../../../lib/requestJson";
import { requireObject } from "../data/bff";
import { isActiveUserManagementStepUp, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";
import { hasAdminAccess } from "../../../lib/applicationRoles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Invitation request failed.";
  const status = error instanceof PythonApiError || error instanceof RequestBodyError ? error.status : 500;
  return NextResponse.json({ error: message }, {
    status,
    headers: error instanceof PythonApiError && error.retryAfter ? { "Retry-After": error.retryAfter } : undefined,
  });
}

async function adminInvitationRequest(request: NextRequest) {
  try {
    const session = await apiSession();
    if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!hasAdminAccess(session.roles)) return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });
    if (!session.roles.includes("master-admin") && (
      !isActiveUserManagementStepUp(session) || request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE)
    )) {
      return NextResponse.json({ error: "Fresh re-authentication is required to manage users.", code: "STEP_UP_REQUIRED" }, { status: 403 });
    }

    if (request.method === "GET") {
      const search = request.nextUrl.searchParams.get("search") ?? "";
      const first = request.nextUrl.searchParams.get("first") ?? "0";
      const max = request.nextUrl.searchParams.get("max") ?? "50";
      const query = `search=${encodeURIComponent(search)}&first=${encodeURIComponent(first)}&max=${encodeURIComponent(max)}`;
      return NextResponse.json({ data: await callPythonApi(`/v1/invitations?${query}`, "GET") }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const body = requireObject(await readJsonBody(request), "Invitation command");
    if (body.action === "create") {
      const { action: _action, ...invite } = body;
      return NextResponse.json({ data: await callPythonApi("/v1/invitations", "POST", invite) }, { status: 201 });
    }
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return NextResponse.json({ error: "A user ID is required." }, { status: 400 });
    }
    const userId = encodeURIComponent(body.userId);
    if (body.action === "resend") {
      const email = typeof body.email === "string" ? body.email : undefined;
      return NextResponse.json({ data: await callPythonApi(`/v1/invitations/${userId}/resend`, "POST", { email }) });
    }
    if (body.action === "revoke") {
      return NextResponse.json({ data: await callPythonApi(`/v1/invitations/${userId}`, "DELETE") });
    }
    return NextResponse.json({ error: "Invitation action is invalid." }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withApiSession(adminInvitationRequest);
export const POST = withApiSession(adminInvitationRequest);
