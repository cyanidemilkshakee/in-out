import { NextRequest, NextResponse } from "next/server";
import { apiSession, withApiSession } from "../../authSession";
import { callPythonApi, PythonApiError } from "../../pythonApi";
import { readJsonBody, RequestBodyError } from "../../../../lib/requestJson";
import { requireObject } from "../../data/bff";
import { hasAdminAccess, hasMasterAdminAccess } from "../../../../lib/applicationRoles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Organization-zone request failed.";
  const status = error instanceof PythonApiError || error instanceof RequestBodyError ? error.status : 400;
  return NextResponse.json({ error: message }, { status });
}

async function zoneItemRequest(request: NextRequest) {
  try {
    const session = await apiSession();
    if (!session?.access_token) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    if (!hasAdminAccess(session.roles)) return NextResponse.json({ error: "Administrator access is required." }, { status: 403 });
    if (!hasMasterAdminAccess(session.roles)) {
      return NextResponse.json({ error: "Only a master-admin can manage organization zones." }, { status: 403 });
    }

    const encodedZoneId = request.nextUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
    let zoneId: string;
    try {
      zoneId = decodeURIComponent(encodedZoneId).trim();
    } catch {
      return NextResponse.json({ error: "Zone ID is invalid." }, { status: 400 });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(zoneId)) {
      return NextResponse.json({ error: "Zone ID is invalid." }, { status: 400 });
    }

    if (request.method === "PATCH") {
      const body = requireObject(await readJsonBody(request), "Organization zone");
      return NextResponse.json({ data: await callPythonApi(`/v1/zones/${encodeURIComponent(zoneId)}`, "PATCH", body) });
    }

    await callPythonApi(`/v1/zones/${encodeURIComponent(zoneId)}`, "DELETE");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = withApiSession(zoneItemRequest);
export const DELETE = withApiSession(zoneItemRequest);
