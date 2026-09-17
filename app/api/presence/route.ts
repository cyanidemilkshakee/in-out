import { fetchPythonApi, PythonApiError } from "../pythonApi";
import { withApiSession } from "../authSession";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = withApiSession(async (request) => {
  try {
    const res = await fetchPythonApi("/v1/presence/stream", "GET", undefined, undefined, request.signal);
    return new Response(res.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Stream unavailable" }, { status: error instanceof PythonApiError ? error.status : 502 });
  }
});
