import { signIn } from "../../auth"
import { keycloakEnabled } from "../../auth"
import styles from "./login.module.css"

export default async function LoginPage(props: {
  searchParams: Promise<{ from?: string; error?: string }>
}) {
  const searchParams = await props.searchParams
  const from = searchParams?.from;
  const redirectTo = from?.startsWith("/") && !from.startsWith("//") ? from : "/admin"
  const errorCode = searchParams?.error

  const errorMessages: Record<string, string> = {
    CredentialsSignin: "Invalid email or password. Please try again.",
    Configuration: "Server configuration error. Contact your administrator.",
    default: "Sign-in failed. Please try again.",
  }
  const errorMessage = errorCode
    ? (errorMessages[errorCode] ?? errorMessages.default)
    : null

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.logo} aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="8" fill="#0b63e5" />
              <path
                d="M11 18h14M18 11l7 7-7 7"
                stroke="#fff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1>IN / OUT</h1>
          <p>Sign in to access the management system</p>
        </div>

        {errorMessage && (
          <div className={styles.errorBanner} role="alert">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {errorMessage}
          </div>
        )}


        <div className={styles.divider} aria-hidden="true">
          <span>or</span>
        </div>

        {keycloakEnabled ? (
          <form
            action={async () => {
              "use server"
              await signIn("keycloak", { redirectTo })
            }}
          >
            <button type="submit" className={`${styles.button} ${styles.buttonSecondary}`}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
                <path d="M9 5v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Sign in with Keycloak SSO
            </button>
          </form>
        ) : (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonSecondary} ${styles.buttonDisabled}`}
            disabled
            title="Keycloak SSO is not configured. Set KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, and KEYCLOAK_ISSUER to enable."
            aria-disabled="true"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Keycloak SSO (not configured)
          </button>
        )}

<p className={styles.hint}>Use your organization’s Keycloak account.</p>
      </div>
    </div>
  )
}
