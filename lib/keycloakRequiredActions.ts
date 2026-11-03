export const KEYCLOAK_REQUIRED_ACTIONS = [
  { id: "UPDATE_PROFILE", label: "Update profile", description: "Review and complete account profile details." },
  { id: "VERIFY_EMAIL", label: "Verify email", description: "Confirm access to the account email address." },
  { id: "CONFIGURE_TOTP", label: "Configure authenticator", description: "Enroll a time-based one-time password authenticator." },
  { id: "UPDATE_PASSWORD", label: "Update password", description: "Choose a permanent password before using the account." },
  { id: "webauthn-register", label: "Register security key or passkey", description: "Register a WebAuthn second factor." },
  { id: "webauthn-register-passwordless", label: "Register passwordless passkey", description: "Register a discoverable WebAuthn credential." },
  { id: "VERIFY_PROFILE", label: "Verify profile", description: "Review profile attributes before account access." },
  { id: "delete_credential", label: "Delete credential", description: "Remove a selected sign-in credential from the account." },
  { id: "idp_link", label: "Link identity provider", description: "Connect an enabled external identity provider." },
  { id: "CONFIGURE_RECOVERY_AUTHN_CODES", label: "Create recovery codes", description: "Generate single-use account recovery codes." },
  { id: "update_user_locale", label: "Choose language", description: "Set the account language preference." },
] as const;

export type KeycloakRequiredAction = (typeof KEYCLOAK_REQUIRED_ACTIONS)[number]["id"];

export function normalizeRequiredActions(value: unknown): KeycloakRequiredAction[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<string>(KEYCLOAK_REQUIRED_ACTIONS.map(({ id }) => id));
  return [...new Set(value.filter((item): item is KeycloakRequiredAction =>
    typeof item === "string" && valid.has(item)))];
}
