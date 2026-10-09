import { AsyncLocalStorage } from "node:async_hooks"
import type { NextRequest } from "next/server"
import { auth } from "../../auth"
import type { AppSession } from "../../lib/keycloakSession"

const requestSessions = new AsyncLocalStorage<{ session: AppSession | null }>()

export function withApiSession(handler: (request: NextRequest) => Promise<Response>) {
  // Auth.js writes refreshed/invalidated session cookies to the response.
  // All upstream calls in this request share that same refreshed token.
  return auth((request) => requestSessions.run(
    { session: request.auth as AppSession | null },
    () => handler(request),
  ))
}

export async function apiSession(): Promise<AppSession | null> {
  const context = requestSessions.getStore()
  return context ? context.session : await auth() as AppSession | null
}
