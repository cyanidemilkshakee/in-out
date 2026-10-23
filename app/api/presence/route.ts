import { PythonApiError } from "../pythonApi";
import { apiSession, withApiSession } from "../authSession";
import type { NextRequest } from "next/server";
import { currentRequestId } from "../../../lib/requestContext";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getPresence(request: NextRequest) {
  try {
    const session = await apiSession();
    const accessToken = session?.access_token;
    if (!session || !accessToken) {
      return Response.json({ error: "Please sign in again." }, { status: 401 });
    }

    const base = process.env.PYTHON_API_URL ?? "http://127.0.0.1:1002";
    const upstream = new URL(`${base}/v1/presence/stream`);
    const since = request.nextUrl.searchParams.get("since");
    const lastId = request.headers.get("last-event-id");
    const validRevision = (value: string) => /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value));
    if ((since !== null && !validRevision(since)) || (lastId !== null && !validRevision(lastId))) {
      return Response.json({ error: "Invalid event revision." }, { status: 422 });
    }
    if (since !== null) upstream.searchParams.set("since", since);

    // SSE streams are long-lived — never apply a hard timeout.
    // Only pass the client's disconnect signal so the upstream
    // connection is torn down when the browser navigates away.
    const res = await fetch(upstream, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "text/event-stream",
        "X-Request-ID": currentRequestId()!,
        ...(lastId !== null ? { "Last-Event-ID": lastId } : {}),
      },
      cache: "no-store",
      signal: request.signal, // client disconnect only — no timeout
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const detail = typeof errorBody.detail === "string" ? errorBody.detail : "Stream unavailable.";
      const retryAfter = res.headers.get("Retry-After");
      throw new PythonApiError(detail, res.status,
        retryAfter && /^\d{1,6}$/.test(retryAfter) ? retryAfter : undefined);
    }

    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof PythonApiError) {
      return Response.json({ error: error.message }, {
        status: error.status,
        headers: error.retryAfter ? { "Retry-After": error.retryAfter } : undefined,
      });
    }
    // Client disconnected — not a real error, suppress it
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return Response.json({ error: "Stream unavailable" }, { status: 502 });
  }
}

export const GET = withApiSession(getPresence);
