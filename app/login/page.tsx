import LoginForm from "./LoginForm"
import styles from "./login.module.css"
import { auth, keycloakEnabled } from "../../auth"
import type { AppSession } from "../../lib/keycloakSession"
import { safeAuthRedirect } from "../../lib/authRequestBoundary"
import { isStepUpDurationMinutes } from "../../lib/userManagementStepUp"
import { hasAdminAccess } from "../../lib/applicationRoles"
import { LOGIN_FAILURE_MESSAGE } from "../../lib/loginMessages"

export default async function LoginPage(props: {
  searchParams: Promise<{ from?: string; error?: string; stepUp?: string; durationMinutes?: string }>
}) {
  const searchParams = await props.searchParams
  const destination = new URL(safeAuthRedirect(searchParams?.from, process.env.AUTH_URL || process.env.NEXTAUTH_URL || "http://localhost"))
  const redirectTo = destination.pathname + destination.search + destination.hash
  const session = searchParams?.stepUp === "1" ? await auth() as AppSession | null : null
  const stepUpLogin = searchParams?.stepUp === "1" && redirectTo === "/admin/users" && !!session?.access_token && hasAdminAccess(session.roles)
  const selectedDuration = Number(searchParams?.durationMinutes)

  const errorMessages: Record<string, string> = {
    Configuration: "Sign-in is temporarily unavailable. Please try again later.",
    default: LOGIN_FAILURE_MESSAGE,
  }
  const initialError = searchParams?.error
    ? Object.hasOwn(errorMessages, searchParams.error) ? errorMessages[searchParams.error] : errorMessages.default
    : undefined

  return (
    <main className={styles.container}>
      <section className={styles.card} aria-labelledby="login-title">
        <header className={styles.header}>
          <div className={styles.logo} aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="8" fill="#e0f0e8" />
              <path
                d="M11 18h14M18 11l7 7-7 7"
                stroke="#087443"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className={styles.brand}>IN / OUT</p>
          <h1 id="login-title">{stepUpLogin ? "Re-authenticate" : "Sign in"}</h1>
          <p className={styles.hint}>Use your organization account to continue.</p>
        </header>

        {keycloakEnabled ? (
          <LoginForm
            redirectTo={redirectTo}
            stepUpLogin={stepUpLogin}
            initialError={initialError}
            initialDurationMinutes={stepUpLogin && isStepUpDurationMinutes(selectedDuration) ? selectedDuration : undefined}
          />
        ) : (
          <div className={styles.errorBanner} role="status">
            Sign-in is unavailable. Contact your administrator.
          </div>
        )}
      </section>
    </main>
  )
}
