export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Container health check; intentionally does not require an authenticated user. */
export function GET() {
  return Response.json({ status: "ok" });
}
