import { NextRequest } from "next/server";
import { withApiSession } from "../authSession";
import { PythonApiError } from "../pythonApi";
import { readJsonBody, RequestBodyError } from "../../../lib/requestJson";
import { executeCommand } from "./commands";
import { CommandValidationError, errorResponse, handleGet, requireObject, requireString, ServerTiming } from "./bff";
import { currentServerTiming, withServerTiming } from "../../../lib/serverTiming";
import { currentRequestId } from "../../../lib/requestContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getData(request: NextRequest) {
  const timing = currentServerTiming() ?? new ServerTiming();
  try {
    return await handleGet(request, timing);
  } catch (error) {
    if (!request.signal.aborted) {
      console.error("[api/data] GET failed", {
        request_id: currentRequestId(),
        status: error instanceof PythonApiError ? error.status : 500,
      });
    }
    return errorResponse(
      error instanceof PythonApiError ? error.message : "Unable to load application data.",
      timing,
      error instanceof PythonApiError ? error.status : 500,
      error instanceof PythonApiError ? error.retryAfter : undefined
    );
  }
}

async function postData(request: NextRequest) {
  const timing = currentServerTiming() ?? new ServerTiming();
  try {
    const parseStartedAt = performance.now();
    const body = requireObject(await readJsonBody(request), "Command");
    timing.add("request_parse", performance.now() - parseStartedAt);
    const action = requireString(body.action, "Command action");
    return await executeCommand(action, body, request, timing);
  } catch (error) {
    const expected = error instanceof PythonApiError || error instanceof RequestBodyError || error instanceof CommandValidationError;
    const status = expected ? error.status : 500;
    if (!request.signal.aborted) {
      console.error("[api/data] POST failed", { request_id: currentRequestId(), status });
    }
    return errorResponse(
      expected ? error.message : "Command failed.",
      timing,
      status,
      error instanceof PythonApiError ? error.retryAfter : undefined
    );
  }
}

const authenticatedGet = withApiSession(getData);
const authenticatedPost = withApiSession(postData);

export function GET(...args: Parameters<typeof authenticatedGet>) {
  return withServerTiming(new ServerTiming(), () => authenticatedGet(...args));
}

export function POST(...args: Parameters<typeof authenticatedPost>) {
  return withServerTiming(new ServerTiming(), () => authenticatedPost(...args));
}
