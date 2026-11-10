import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, RequestBodyError } from "../../../../lib/requestJson";
import { requireObject } from "../../data/bff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : null;
  if (!origin || !expectedOrigin || origin !== expectedOrigin) {
    return NextResponse.json({ error: "This invitation request could not be verified." }, { status: 403 });
  }
  try {
    const body = requireObject(await readJsonBody(request), "Invitation acceptance");
    const base = process.env.PYTHON_API_URL ?? "http://127.0.0.1:1002";
    const response = await fetch(`${base}/v1/invitations/accept`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: body.userId, token: body.token }),
    });
    const result = await response.json().catch(() => null) as { detail?: unknown; accepted?: unknown } | null;
    if (!response.ok || result?.accepted !== true) {
      const detail = typeof result?.detail === "string" ? result.detail : "The invitation could not be accepted.";
      return NextResponse.json({ error: detail }, { status: response.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ accepted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "The invitation service is unavailable. Please try again." }, { status: 503 });
  }
}
