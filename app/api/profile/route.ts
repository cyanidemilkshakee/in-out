import { NextRequest, NextResponse } from "next/server";
import type {
  CreateAdminAccountInput,
  UpdateAdminProfileInput,
} from "../../../services/profileService";
import { callPythonApi, PythonApiError } from "../pythonApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Normalize the Python API snake_case response to the camelCase shape expected by the frontend. */
function normalizeProfile(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id:            raw.id,
    name:          raw.name,
    nickname:      raw.nickname,
    email:         raw.email,
    avatarDataUrl: raw.avatar_data_url ?? raw.avatarDataUrl ?? "",
    autoLock:      raw.auto_lock      ?? raw.autoLock      ?? "15",
    settings:      raw.settings       ?? {},
    isCurrent:     raw.is_current     ?? raw.isCurrent     ?? false,
    createdAt:     raw.created_at     ?? raw.createdAt,
  };
}

function response<T>(data: T) {
  return NextResponse.json({ data });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Profile request failed.";
  return NextResponse.json(
    { error: message },
    { status: error instanceof PythonApiError ? error.status : message.includes("already exists") ? 409 : 400 }
  );
}

export async function GET() {
  try {
    const raw = await callPythonApi('/v1/admin/profile', 'GET') as Record<string, unknown>;
    return response(normalizeProfile(raw));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const raw = await callPythonApi('/v1/admin/profile', 'PATCH', await request.json()) as Record<string, unknown>;
    return response(normalizeProfile(raw));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const raw = await callPythonApi('/v1/admin/profile/accounts', 'POST', await request.json()) as Record<string, unknown>;
    return response(normalizeProfile(raw));
  } catch (error) {
    return errorResponse(error);
  }
}
