import { NextRequest } from "next/server";
import { withApiSession } from "../authSession";
import { PythonApiError } from "../pythonApi";
import { executeCommand } from "./commands";
import { errorResponse, handleGet, requireObject, requireString, ServerTiming } from "./bff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getData(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    return await handleGet(request, timing);
  } catch (error) {
    console.error("[api/data] GET failed", {
      path: request.nextUrl.pathname,
      query: request.nextUrl.search,
      error,
    });
    return errorResponse(
      error instanceof Error ? error.message : "Unable to load application data.",
      timing,
      error instanceof PythonApiError ? error.status : 500
    );
  }
}

async function postData(request: NextRequest) {
  const timing = new ServerTiming();
  let action = "unknown";
  try {
    const parseStartedAt = performance.now();
    const body = requireObject(await request.json(), "Command");
    timing.add("request_parse", performance.now() - parseStartedAt);
    action = requireString(body.action, "Command action");
    return await executeCommand(action, body, request, timing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed.";
    console.error("[api/data] POST failed", {
      path: request.nextUrl.pathname,
      action,
      error,
    });
    const conflict = message.includes("already assigned") || message.includes("already exists");
    return errorResponse(
      message,
      timing,
      error instanceof PythonApiError ? error.status : conflict ? 409 : 400
    );
  }
}

export const GET = withApiSession(getData);
export const POST = withApiSession(postData);
