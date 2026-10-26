import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../authSession";
import { callPythonApi, PythonApiError } from "../pythonApi";
import { readJsonBody, RequestBodyError } from "../../../lib/requestJson";
import { requireObject } from "../data/bff";
import { hasAdminAccess } from "../../../lib/applicationRoles";
import { isActiveUserManagementStepUp, USER_MANAGEMENT_STEP_UP_LOCK_COOKIE } from "../../../lib/userManagementStepUp";
import { userManagementWindowUnlocked } from "../../../lib/serverUserManagement";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Checkpoint request failed.";
  const status = error instanceof PythonApiError || error instanceof RequestBodyError ? error.status : 400;
  return NextResponse.json({ error: message }, { status });
}

async function checkpointsRequest(request: NextRequest) {
  try {
    const session = await apiSession();
    if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!hasAdminAccess(session.roles)) return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });

    if (request.method === "GET") {
      return NextResponse.json({ data: await callPythonApi("/v1/checkpoints", "GET") }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (!isActiveUserManagementStepUp(session) || request.cookies.has(USER_MANAGEMENT_STEP_UP_LOCK_COOKIE) ||
        !await userManagementWindowUnlocked(session)) {
      return NextResponse.json({ error: "Fresh re-authentication is required to manage checkpoints.", code: "STEP_UP_REQUIRED" }, { status: 403 });
    }

    if (request.method === "POST") {
      const body = requireObject(await readJsonBody(request), "Checkpoint");
      return NextResponse.json({ data: await callPythonApi("/v1/checkpoints", "POST", body) }, { status: 201 });
    }

    const checkpointId = request.nextUrl.searchParams.get("checkpointId")?.trim();
    if (!checkpointId) return NextResponse.json({ error: "Checkpoint ID is required." }, { status: 400 });
    await callPythonApi(`/v1/checkpoints/${encodeURIComponent(checkpointId)}`, "DELETE");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withApiSession(checkpointsRequest);
export const POST = withApiSession(checkpointsRequest);
export const DELETE = withApiSession(checkpointsRequest);
