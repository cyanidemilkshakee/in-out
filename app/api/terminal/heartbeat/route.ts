import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../../authSession";
import { callPythonApi, PythonApiError } from "../../pythonApi";
import { hasAdminAccess } from "../../../../lib/applicationRoles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function postHeartbeat(_request: NextRequest) {
  try {
    const payload = await _request.json().catch(() => null) as { checkpointId?: unknown } | null;
    if (typeof payload?.checkpointId !== "string" || !payload.checkpointId) {
      return NextResponse.json({ error: "A checkpoint assignment is required." }, { status: 400 });
    }
    const session = await apiSession();
    if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!hasAdminAccess(session.roles) && !session.roles.includes("operator")) {
      return NextResponse.json({ error: "Terminal access is required." }, { status: 403 });
    }
    const data = await callPythonApi("/v1/terminal/heartbeat", "POST", { checkpointId: payload.checkpointId });
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record the terminal heartbeat.";
    const status = error instanceof PythonApiError ? error.status : 503;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withApiSession(postHeartbeat);
