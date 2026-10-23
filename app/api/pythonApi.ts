import { apiRequestId, apiSession } from "./authSession"
import { isActiveUserManagementStepUp, signStepUpProof } from "../../lib/userManagementStepUp"
import type { AppSession } from "../../lib/keycloakSession"
import { currentServerTiming } from "../../lib/serverTiming"
import { upstreamRoute } from "../../lib/requestContext"

export class PythonApiError extends Error {
  constructor(message: string, public status: number, public retryAfter?: string) { super(message); }
}

const UPSTREAM_TIMEOUT_MS = 15_000;
// Keep parse diagnostics tied to the chosen outbound ID, including SSR calls
// outside the route's async context. Weak keys do not retain completed responses.
const responseRequestIds = new WeakMap<Response, string>();

type PythonApiOptions = { signal?: AbortSignal; timeoutMs?: number; session?: AppSession };

export async function fetchPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string, options: PythonApiOptions = {}) {
  if (path.split("?", 1)[0] === "/v1/checkpoints" && method.toUpperCase() !== "GET") {
    throw new PythonApiError("Facility checkpoints are fixed and cannot be changed through the application.", 405);
  }

  const base = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:1002';
  const url = base + path;

  // Reuse the caller's request snapshot when supplied. This keeps step-up
  // proofs bound to the exact bearer token that the caller already validated.
  const session = options.session ?? await apiSession()
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
    "X-Request-ID": await apiRequestId(),
  }

  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (accessToken) {
    // Keycloak SSO session — forward the real Bearer token.
    headers["Authorization"] = `Bearer ${accessToken}`
  }

  if (/^\/v1\/keycloak\/users(?:\/|\?|$)/.test(path) || /^\/v1\/user-management\/(?:window|lock)$/.test(path)) {
    if (!isActiveUserManagementStepUp(session)) throw new PythonApiError("Fresh re-authentication is required to manage users.", 403);
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new PythonApiError("Authentication is not configured.", 503);
    headers["X-InOut-Step-Up"] = await signStepUpProof(session, accessToken, secret);
  }

  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
    const upstreamSignal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const upstreamStartedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        cache: "no-store",
        signal: upstreamSignal,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } finally {
      currentServerTiming()?.add("upstream", performance.now() - upstreamStartedAt);
    }
    responseRequestIds.set(res, headers["X-Request-ID"]);
    if (!res.ok) {
      const parseStartedAt = performance.now();
      const errorBody = await res.json().catch(() => ({}));
      currentServerTiming()?.add("upstream_parse", performance.now() - parseStartedAt);
      const detail = typeof errorBody.detail === "string" ? errorBody.detail
        : typeof errorBody.detail?.message === "string" ? errorBody.detail.message
        : typeof errorBody.message === "string" ? errorBody.message : 'Backend request failed.';
      console.error("[python-api] upstream request failed", {
        method,
        route: upstreamRoute(path),
        request_id: headers["X-Request-ID"],
        status: res.status,
      });
      const retryAfter = res.headers.get("Retry-After");
      throw new PythonApiError(detail, res.status,
        retryAfter && /^\d{1,6}$/.test(retryAfter) ? retryAfter : undefined);
    }
    return res;
  } catch (error) {
    if (!(error instanceof PythonApiError)) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new PythonApiError("Backend request timed out.", 504);
      }
      if (!options.signal?.aborted) {
        console.error("[python-api] upstream request could not be completed", {
          method,
          route: upstreamRoute(path),
          request_id: headers["X-Request-ID"],
          error_type: error instanceof Error ? error.name : "UnknownError",
        });
      }
      throw new PythonApiError("Backend service is unavailable. Please try again.", 502);
    }
    throw error;
  }
}
export async function callPythonApi(path: string, method: string, body?: unknown, idempotencyKey?: string, options?: PythonApiOptions) {
  const response = await fetchPythonApi(path, method, body, idempotencyKey, options);
  const parseStartedAt = performance.now();
  try {
    return await response.json();
  } catch (error) {
    if (!options?.signal?.aborted) console.error("[python-api] upstream returned invalid JSON", {
      method, route: upstreamRoute(path), request_id: responseRequestIds.get(response),
      error_type: error instanceof Error ? error.name : "UnknownError",
    });
    throw new PythonApiError("Backend returned an invalid response.", 502);
  } finally {
    currentServerTiming()?.add("upstream_parse", performance.now() - parseStartedAt);
  }
}
