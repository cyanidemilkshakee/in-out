import type { AppSession } from "./keycloakSession";
import { isActiveUserManagementStepUp, isStepUpWindowId } from "./userManagementStepUp";
import { callPythonApi, PythonApiError } from "../app/api/pythonApi";

const STEP_UP_REQUIRED = "Step-up authentication required before managing users";

function isLockedWindow(error: unknown): boolean {
  return error instanceof PythonApiError && error.status === 401 && error.message === STEP_UP_REQUIRED;
}

function hasWindow(session: AppSession) {
  return isActiveUserManagementStepUp(session) && isStepUpWindowId(session.stepUpWindowId);
}

export async function userManagementWindowUnlocked(session: AppSession): Promise<boolean> {
  if (!hasWindow(session)) return false;
  try {
    const state = await callPythonApi("/v1/user-management/window", "GET", undefined, undefined, { timeoutMs: 5_000, session });
    return state?.unlocked === true;
  } catch (error) {
    // The backend uses 401 to say that a locally valid step-up proof no longer
    // represents an open window. Treat that as locked so callers can send the
    // user through fresh authentication instead of failing the whole page.
    if (isLockedWindow(error)) return false;
    throw error;
  }
}

export async function lockUserManagementWindow(session: AppSession): Promise<void> {
  if (hasWindow(session)) {
    try {
      await callPythonApi("/v1/user-management/lock", "POST", {}, undefined, { timeoutMs: 5_000, session });
    } catch (error) {
      // An already-rejected/expired window is already locked from the app's
      // point of view. Keep re-authentication flows moving in that case.
      if (!isLockedWindow(error)) throw error;
    }
  }
}
