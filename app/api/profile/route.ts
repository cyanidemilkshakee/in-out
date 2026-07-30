import { NextRequest, NextResponse } from "next/server";
import type {
  CreateAdminAccountInput,
  UpdateAdminProfileInput,
} from "../../../services/profileService";
import {
  createAdminAccount,
  getCurrentAdminProfile,
  updateCurrentAdminProfile,
} from "../../../backend/profileRepository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response<T>(data: T) {
  return NextResponse.json({ data });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Profile request failed.";
  return NextResponse.json(
    { error: message },
    { status: message.includes("already exists") ? 409 : 400 }
  );
}

export async function GET() {
  try {
    return response(await getCurrentAdminProfile());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    return response(
      await updateCurrentAdminProfile(
        (await request.json()) as UpdateAdminProfileInput
      )
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    return response(
      await createAdminAccount((await request.json()) as CreateAdminAccountInput)
    );
  } catch (error) {
    return errorResponse(error);
  }
}
