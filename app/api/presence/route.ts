import { PythonApiError } from "../pythonApi";
import { apiSession } from "../authSession";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await apiSession();
    const accessToken = session?.access_token;
    if (!session || !accessToken) {
      return Response.json({ error: "Please sign in again." }, { status: 401 });
    }

    const base = process.env.PYTHON_API_URL ?? "http://127.0.0.1:1002";

    // SSE streams are long-lived — never apply a hard timeout.
    // Only pass the client's disconnect signal so the upstream
    // connection is torn down when the browser navigates away.
    const res = await fetch(`${base}/v1/presence/stream`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "text/event-stream",
      },
      cache: "no-store",
      signal: request.signal, // client disconnect only — no timeout
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const detail = typeof errorBody.detail === "string" ? errorBody.detail : "Stream unavailable.";
      throw new PythonApiError(detail, res.status);
    }

    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no", // disable Nginx buffering for SSE
      },
    });
  } catch (error) {
    if (error instanceof PythonApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // Client disconnected — not a real error, suppress it
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return Response.json({ error: "Stream unavailable" }, { status: 502 });
  }
}
