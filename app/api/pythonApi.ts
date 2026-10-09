import { apiSession } from "./authSession"
import { isActiveUserManagementStepUp, signStepUpProof } from "../../lib/userManagementStepUp"

export class PythonApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const UPSTREAM_TIMEOUT_MS = 15_000;

export async function fetchPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string, signal?: AbortSignal) {
  const base = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:1002';
  const url = base + path;

  // Server auth() includes the bearer token; /api/auth/session never exposes it.
  const session = await apiSession()
  const accessToken = session?.access_token
  if (!session || !accessToken) {
    console.warn("[python-api] server session has no access token", {
      hasSession: Boolean(session),
      sessionError: session?.error,
    })
    throw new PythonApiError("Please sign in again.", 401)
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (accessToken) {
    // Keycloak SSO session — forward the real Bearer token.
    headers["Authorization"] = `Bearer ${accessToken}`
  }

  if (/^\/v1\/keycloak\/users(?:\/|\?|$)/.test(path)) {
    if (!isActiveUserManagementStepUp(session)) throw new PythonApiError("Fresh re-authentication is required to manage users.", 403);
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new PythonApiError("Authentication is not configured.", 503);
    headers["X-InOut-Step-Up"] = await signStepUpProof(session, accessToken, secret);
  }

  try {
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const upstreamSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(url, {
      method,
      headers,
      cache: "no-store",
      signal: upstreamSignal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const detail = typeof errorBody.detail === "string" ? errorBody.detail : 'Backend request failed.';
      console.error("[python-api] upstream request failed", {
        method,
        path,
        status: res.status,
        detail,
      });
      throw new PythonApiError(detail, res.status);
    }
    return res;
  } catch (error) {
    if (!(error instanceof PythonApiError)) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new PythonApiError("Backend request timed out.", 504);
      }
      console.error("[python-api] upstream request could not be completed", {
        method,
        path,
        error,
      });
      throw new PythonApiError("Backend service is unavailable. Please try again.", 502);
    }
    throw error;
  }
}
export async function callPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string) {
  const response = await fetchPythonApi(path, method, body, idempotencyKey);
  try {
    return await response.json();
  } catch (error) {
    console.error("[python-api] upstream returned invalid JSON", { method, path, error });
    throw new PythonApiError("Backend returned an invalid response.", 502);
  }
}
