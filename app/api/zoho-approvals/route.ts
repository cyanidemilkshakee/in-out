import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function retired() {
  return NextResponse.json({ error: "Zoho sign-in approvals have been replaced by invitation-based account creation." }, {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = retired;
export const POST = retired;
