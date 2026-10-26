import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../authSession";
import { callPythonApi, PythonApiError } from "../pythonApi";
import { readJsonBody, RequestBodyError } from "../../../lib/requestJson";
import { requireObject } from "../data/bff";
import { hasAdminAccess, hasMasterAdminAccess } from "../../../lib/applicationRoles";
import { isActiveUserManagementStepUp, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";
import { userManagementWindowUnlocked } from "../../../lib/serverUserManagement";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Organization-zone request failed.";
  const status = error instanceof PythonApiError || error instanceof RequestBodyError ? error.status : 400;
  return NextResponse.json({ error: message }, { status });
}

async function zonesRequest(request: NextRequest) {
  try {
    const session = await apiSession();
    if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!hasAdminAccess(session.roles)) return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });

    if (request.method === "GET") {
      return NextResponse.json({ data: await callPythonApi("/v1/zones", "GET") }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (!hasMasterAdminAccess(session.roles)) {
      return NextResponse.json({ error: "Only a master-admin can manage organization zones." }, { status: 403 });
    }
    if (!isActiveUserManagementStepUp(session) || request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) ||
        !await userManagementWindowUnlocked(session)) {
      return NextResponse.json({ error: "Fresh re-authentication is required to manage organization zones.", code: "STEP_UP_REQUIRED" }, { status: 403 });
    }

    if (request.method === "POST") {
      const body = requireObject(await readJsonBody(request), "Organization zone");
      return NextResponse.json({ data: await callPythonApi("/v1/zones", "POST", body) }, { status: 201 });
    }

    const zoneId = request.nextUrl.searchParams.get("zoneId")?.trim();
    if (!zoneId) return NextResponse.json({ error: "Zone ID is required." }, { status: 400 });
    await callPythonApi(`/v1/zones/${encodeURIComponent(zoneId)}`, "DELETE");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withApiSession(zonesRequest);
export const POST = withApiSession(zonesRequest);
export const DELETE = withApiSession(zonesRequest);
