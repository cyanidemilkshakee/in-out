import { apiSession } from "./authSession"

export class PythonApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function fetchPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string, signal?: AbortSignal) {
  const base = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:1002';
  const url = base + path;

  // Server auth() includes the bearer token; /api/auth/session never exposes it.
  const session = await apiSession()
  const accessToken = session?.access_token
  if (!session || !accessToken) throw new PythonApiError("Please sign in again.", 401);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (accessToken) {
    // Keycloak SSO session — forward the real Bearer token.
    headers["Authorization"] = `Bearer ${accessToken}`
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      cache: "no-store",
      signal,
      body: body ? JSON.stringify(body) : undefined,
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
      console.error("[python-api] upstream request could not be completed", {
        method,
        path,
        error,
      });
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
    throw error;
  }
}
