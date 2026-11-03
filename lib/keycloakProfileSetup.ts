import { keycloakInteractionRequest, validInteractionSubject, type KeycloakInteractionConfig } from "./keycloakInteractions"

export type ProfileSetupErrorCode = "invalid_request" | "credentials" | "state_changed" |
  "profile_invalid" | "service_unavailable"

export class ProfileSetupError extends Error {
  constructor(readonly code: ProfileSetupErrorCode, readonly status: number, message: string) { super(message) }
}

export type KeycloakProfileSetupInput = {
  username: string
  currentPassword: string
  email: string
  firstName: string
  lastName: string
  otp?: string
}

const credentialsError = () => new ProfileSetupError("credentials", 401,
  "The current password or authenticator code could not be verified.")
const unavailableError = () => new ProfileSetupError("service_unavailable", 503,
  "Profile updates are temporarily unavailable. Please try again.")

function validateInput(input: KeycloakProfileSetupInput) {
  if (!input || typeof input.username !== "string" || !input.username.trim() || input.username.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(input.username) || typeof input.currentPassword !== "string" ||
      !input.currentPassword || input.currentPassword.length > 128 || typeof input.email !== "string" ||
      !input.email.trim() || input.email.length > 254 || typeof input.firstName !== "string" ||
      !input.firstName.trim() || input.firstName.length > 256 || typeof input.lastName !== "string" ||
      !input.lastName.trim() || input.lastName.length > 256 ||
      [input.email, input.firstName, input.lastName].some((value) => /[\u0000-\u001f\u007f]/.test(value)) ||
      (input.otp !== undefined && (typeof input.otp !== "string" || (input.otp !== "" && !/^\d{6,8}$/.test(input.otp))))) {
    throw new ProfileSetupError("invalid_request", 400, "Enter your email, first name, last name, and current password.")
  }
}

async function providerError(response: Response, update: boolean): Promise<never> {
  if (response.status === 429 || response.status >= 500) throw unavailableError()
  const body = await response.json().catch(() => null)
  if (response.status === 401 && body?.error === "credentials") throw credentialsError()
  if (response.status === 409 && body?.error === "state_changed") {
    throw new ProfileSetupError("state_changed", 409, "The account changed. Return to sign in and try again.")
  }
  if (response.status === 422 && body?.error === "profile_invalid") {
    throw new ProfileSetupError("profile_invalid", 422, "Enter profile details that meet the account requirements.")
  }
  if (!update && response.status === 401 && ["not_ready", "account_setup_required"].includes(body?.error)) throw credentialsError()
  throw unavailableError()
}

/** Pin the account by subject, re-check its current password and required
 * profile action in Keycloak, then let Keycloak's User Profile SPI validate
 * and apply the permitted self-service fields in the provider transaction.
 */
export async function prepareKeycloakProfile(input: KeycloakProfileSetupInput,
  config: KeycloakInteractionConfig, fetcher: typeof fetch = fetch): Promise<string> {
  validateInput(input)
  try {
    const prepared = await keycloakInteractionRequest(config, "prepare", { username: input.username.trim() }, fetcher)
    if (!prepared.ok) await providerError(prepared, false)
    const target = await prepared.json() as Record<string, unknown>
    if (!validInteractionSubject(target.subject)) throw unavailableError()
    return target.subject
  } catch (error) {
    if (error instanceof ProfileSetupError) throw error
    throw unavailableError()
  }
}

export async function completeKeycloakProfile(input: KeycloakProfileSetupInput, expectedSubject: string,
  config: KeycloakInteractionConfig, fetcher: typeof fetch = fetch): Promise<void> {
  validateInput(input)
  if (!validInteractionSubject(expectedSubject)) throw credentialsError()
  try {
    let response: Response
    try {
      response = await keycloakInteractionRequest(config, "verify", {
        mode: "profile", username: input.username.trim(), currentPassword: input.currentPassword,
        email: input.email.trim(), firstName: input.firstName.trim(), lastName: input.lastName.trim(),
        ...(input.otp ? { otp: input.otp } : {}), expectedSubject,
      }, fetcher)
    } catch { throw unavailableError() }
    if (!response.ok) await providerError(response, true)
    const result = await response.json().catch(() => null)
    if (result?.ok !== true || result.subject !== expectedSubject) throw unavailableError()
  } catch (error) {
    if (error instanceof ProfileSetupError) throw error
    throw unavailableError()
  }
}
