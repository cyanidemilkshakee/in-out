export class PythonApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function fetchPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string, signal?: AbortSignal) {
  const base = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:8000';
  const url = base + path;

  // Obtain the Keycloak access_token from the current NextAuth session.
  // The token is stored in the session by the jwt/session callbacks in auth.ts.
  const session = await import("../../auth").then((m) => m.auth())
  const accessToken = (session as any)?.access_token as string | undefined
  if (!session || !accessToken) throw new PythonApiError("Please sign in again.", 401);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (accessToken) {
    // Keycloak SSO session — forward the real Bearer token.
    headers["Authorization"] = `Bearer ${accessToken}`
  }

  const res = await fetch(url, {
    method,
    headers,
    cache: "no-store",
    signal,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new PythonApiError(typeof errorBody.detail === "string" ? errorBody.detail : 'Backend request failed.', res.status);
  }
  return res;
}
export async function callPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string) {
  return (await fetchPythonApi(path, method, body, idempotencyKey)).json();
}
