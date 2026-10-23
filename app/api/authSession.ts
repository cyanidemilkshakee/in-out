import { AsyncLocalStorage } from "node:async_hooks"
import type { NextRequest } from "next/server"
import { headers as incomingHeaders } from "next/headers"
import { cache } from "react"
import { auth } from "../../auth"
import type { AppSession } from "../../lib/keycloakSession"
import { currentServerTiming } from "../../lib/serverTiming"
import { currentRequestId, normalizedRequestId, withRequestContext } from "../../lib/requestContext"

const requestSessions = new AsyncLocalStorage<{ session: AppSession | null }>()
// React's server cache is scoped to the current render, never shared by users.
const renderedRequestId = cache(async () => normalizedRequestId((await incomingHeaders()).get("X-Request-ID")))

export function withApiSession(handler: (request: NextRequest) => Promise<Response>) {
  // Auth.js writes refreshed/invalidated session cookies to the response.
  // All upstream calls in this request share that same refreshed token.
  return auth((request) => {
    currentServerTiming()?.authenticated()
    return withRequestContext(request.headers.get("X-Request-ID"), async () => {
      const startedAt = performance.now()
      let status = 500
      try {
        const response = await requestSessions.run(
          { session: request.auth as AppSession | null },
          () => handler(request),
        )
        status = response.status
        response.headers.set("X-Request-ID", currentRequestId()!)
        return response
      } finally {
        console.info(JSON.stringify({
          event: "bff_request", request_id: currentRequestId(), method: request.method,
          status, duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        }))
      }
    })
  })
}

export async function apiSession(): Promise<AppSession | null> {
  const context = requestSessions.getStore()
  return context ? context.session : await auth() as AppSession | null
}

export async function apiRequestId(): Promise<string> {
  const current = currentRequestId()
  if (current) return current
  // Server-rendered pages call the same helper without an API-route wrapper.
  // Preserve the gateway's navigation ID across their concurrent upstream reads.
  return renderedRequestId()
}
