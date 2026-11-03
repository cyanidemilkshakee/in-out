import { keycloakInteractionRequest, validInteractionSubject, type KeycloakInteractionConfig } from "./keycloakInteractions"

export type PasswordUpdateFailureCode = "invalid_request" | "credentials" | "not_ready" | "state_changed" |
  "password_policy" | "service_unavailable" | "update_unconfirmed"

export class PasswordUpdateError extends Error {
  constructor(readonly code: PasswordUpdateFailureCode, readonly status: number, message: string) { super(message) }
}

export type KeycloakPasswordUpdateConfig = KeycloakInteractionConfig

export type PasswordUpdateInput = {
  mode: "setup" | "change"
  username: string
  currentPassword: string
  newPassword: string
  otp?: string
  expectedSubject?: string
}

export type KeycloakPasswordUpdateOptions = {
  fetcher?: typeof fetch
  withUserLock: <T>(subject: string, operation: () => Promise<T>) => Promise<T>
}

const credentialsError = () => new PasswordUpdateError("credentials", 401, "The current password or authenticator code could not be verified.")
const unavailableError = () => new PasswordUpdateError("service_unavailable", 503, "Password updates are temporarily unavailable. Please try again.")
const changedError = () => new PasswordUpdateError("state_changed", 409, "The account changed during verification. Sign in again before retrying.")
const unconfirmedError = () => new PasswordUpdateError("update_unconfirmed", 503,
  "The password update could not be confirmed. Try signing in with the new password before submitting another update.")

function validateInput(input: PasswordUpdateInput) {
  if (!input || !["setup", "change"].includes(input.mode) ||
      typeof input.username !== "string" || !input.username.trim() || input.username.length > 254 || /[\u0000-\u001f\u007f]/.test(input.username) ||
      typeof input.currentPassword !== "string" || !input.currentPassword || input.currentPassword.length > 128 ||
      typeof input.newPassword !== "string" || !input.newPassword.trim() || input.newPassword.length > 128 || input.newPassword === input.currentPassword ||
      (input.otp !== undefined && (typeof input.otp !== "string" || (input.otp !== "" && !/^\d{6,8}$/.test(input.otp))))) {
    throw new PasswordUpdateError("invalid_request", 400, "Enter the account, current password and a different new password of at most 128 characters.")
  }
  if (input.mode === "change" && !validInteractionSubject(input.expectedSubject)) throw credentialsError()
}

async function responseError(response: Response, mutation: boolean): Promise<never> {
  if (response.status === 429) throw unavailableError()
  if (response.status >= 500) throw mutation ? unconfirmedError() : unavailableError()
  const body = await response.json().catch(() => null)
  if (response.status === 401 && body?.error === "credentials") throw credentialsError()
  if (response.status === 409 && body?.error === "state_changed") throw changedError()
  if (response.status === 422 && body?.error === "password_policy") {
    throw new PasswordUpdateError("password_policy", 422, "The new password was not accepted by the account's password policy.")
  }
  // Do not publish eligibility, disabled-account or other provider details.
  if (["credentials", "not_ready", "account_setup_required"].includes(body?.error)) throw credentialsError()
  throw unavailableError()
}

/** The provider verifies credentials, OTP, account state and password policy,
 * then changes credentials in its own transaction. The app pins the target ID
 * before acquiring its existing cross-replica lease, including email aliases.
 * No password grants, administrative service tokens or reset APIs are used.
 */
export async function updateKeycloakPassword(input: PasswordUpdateInput, config: KeycloakPasswordUpdateConfig,
  options: KeycloakPasswordUpdateOptions): Promise<{ subject: string }> {
  validateInput(input)
  if (typeof options?.withUserLock !== "function") throw unavailableError()
  const fetcher = options.fetcher || fetch
  try {
    const prepared = await keycloakInteractionRequest(config, "prepare", { username: input.username.trim(),
      ...(input.mode === "change" ? { expectedSubject: input.expectedSubject } : {}) }, fetcher)
    if (!prepared.ok) await responseError(prepared, false)
    const target = await prepared.json() as Record<string, unknown>
    if (!validInteractionSubject(target.subject)) throw unavailableError()
    const subject = target.subject
    if (input.mode === "change" && subject !== input.expectedSubject) throw credentialsError()
    return await options.withUserLock(subject, async () => {
      let response: Response
      try {
        response = await keycloakInteractionRequest(config, "verify", { mode: input.mode, username: input.username.trim(),
          currentPassword: input.currentPassword, newPassword: input.newPassword,
          ...(input.otp ? { otp: input.otp } : {}), expectedSubject: subject }, fetcher)
      } catch { throw unconfirmedError() }
      if (!response.ok) await responseError(response, true)
      const result = await response.json().catch(() => null)
      if (result?.ok !== true || result.subject !== subject) throw unconfirmedError()
      return { subject }
    })
  } catch (error) {
    if (error instanceof PasswordUpdateError) throw error
    throw unavailableError()
  }
}
