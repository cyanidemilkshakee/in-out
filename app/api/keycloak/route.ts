import { NextRequest, NextResponse } from "next/server";
import { withApiSession } from "../authSession";
import { callPythonApi, PythonApiError } from "../pythonApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Identity request failed.";
  return NextResponse.json({ error: message }, { status: error instanceof PythonApiError ? error.status : 400 });
}

async function identityRequest(request: NextRequest) {
  try {
    if (request.method === "GET") {
      const search = request.nextUrl.searchParams.get("search") ?? "";
      const first = request.nextUrl.searchParams.get("first") ?? "0";
      const max = request.nextUrl.searchParams.get("max") ?? "50";
      return NextResponse.json({ data: await callPythonApi(`/v1/keycloak/users?search=${encodeURIComponent(search)}&first=${encodeURIComponent(first)}&max=${encodeURIComponent(max)}`, "GET") });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    if (typeof action !== "string") return NextResponse.json({ error: "Identity action is required." }, { status: 400 });
    const userId = typeof body.userId === "string" ? body.userId : "";
    let result: unknown;
    if (action === "createUser") result = await callPythonApi("/v1/keycloak/users", "POST", body.input);
    else if (action === "updateUser" && userId) result = await callPythonApi(`/v1/keycloak/users/${encodeURIComponent(userId)}`, "PATCH", body.input);
    else if (action === "setRoles" && userId) result = await callPythonApi(`/v1/keycloak/users/${encodeURIComponent(userId)}/roles`, "PUT", body.input);
    else if (action === "resetPassword" && userId) result = await callPythonApi(`/v1/keycloak/users/${encodeURIComponent(userId)}/password`, "PUT", body.input);
    else if (action === "endSessions" && userId) result = await callPythonApi(`/v1/keycloak/users/${encodeURIComponent(userId)}/logout`, "POST");
    else return NextResponse.json({ error: "Identity action is invalid." }, { status: 400 });
    return NextResponse.json({ data: result });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withApiSession(identityRequest);
export const POST = withApiSession(identityRequest);
