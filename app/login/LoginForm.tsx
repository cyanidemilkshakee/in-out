"use client"

import { useRef, useState, type FormEvent } from "react"
import { getCsrfToken, signIn } from "next-auth/react"
import Link from "next/link"
import { StepUpDurationSelect } from "../../frontend/components/admin/StepUpDurationSelect"
import { DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, type StepUpDurationMinutes } from "../../lib/userManagementStepUp"
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../../lib/passwordLimits"
import styles from "./login.module.css"

type LoginFormProps = {
  redirectTo: string
  stepUpLogin: boolean
  initialError?: string
  passwordSetupSignoutRequired?: boolean
  initialDurationMinutes?: StepUpDurationMinutes
}

export default function LoginForm({ redirectTo, stepUpLogin, initialError, passwordSetupSignoutRequired = false, initialDurationMinutes = DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES }: LoginFormProps) {
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [otp, setOtp] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [accountSetupRequired, setAccountSetupRequired] = useState(false)
  const [profileSetupRequired, setProfileSetupRequired] = useState(false)
  const [email, setEmail] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [durationMinutes, setDurationMinutes] = useState<StepUpDurationMinutes>(initialDurationMinutes)
  const pending = useRef(false)

  async function beginSignIn() {
    if (pending.current) return
    pending.current = true
    setError(null)
    setSuccess(null)
    setAccountSetupRequired(false)
    setProfileSetupRequired(false)
    setSubmitting(true)
    let navigating = false

    try {
      if (stepUpLogin) {
        const prepared = await fetch("/api/auth/step-up", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationMinutes }),
        })
        if (!prepared.ok) {
          setError(prepared.status === 429 ? "Too many attempts. Wait a minute and try again." : "Unable to prepare re-authentication. Please try again.")
          return
        }
      }

      const csrfToken = await getCsrfToken()
      if (!csrfToken) throw new Error("Sign-in could not be prepared.")
      const response = await fetch("/api/auth/callback/credentials", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ username, password, otp, csrfToken, callbackUrl: redirectTo }),
      })
      if (!response.ok) {
        setError(response.status === 429 ? "Too many attempts. Wait a minute and try again." : "Sign-in is temporarily unavailable. Please try again later.")
        return
      }
      const result: unknown = await response.json()
      if (!result || typeof result !== "object" || !("url" in result) || typeof result.url !== "string") {
        throw new Error("Sign-in response is invalid.")
      }
      const destination = new URL(result.url, window.location.origin)
      if (destination.origin !== window.location.origin || destination.username || destination.password) {
        throw new Error("Sign-in response is invalid.")
      }
      const errorCode = destination.searchParams.get("error")
      const failureCode = destination.searchParams.get("code")
      if (errorCode) {
        if (failureCode === "account_setup_required") {
          if (stepUpLogin) {
            setError("This account needs first-time password setup. Sign out and complete setup before re-authenticating. Your current session has not been changed.")
          } else {
            setAccountSetupRequired(true)
            setError(null)
          }
        }
        else if (failureCode === "profile_setup_required") {
          if (stepUpLogin) setError("Complete the account profile from the sign-in page before re-authenticating.")
          else {
            setProfileSetupRequired(true)
            setError(null)
          }
        }
        else if (stepUpLogin && failureCode === "step_up_account_mismatch") {
          setError("Re-authenticate with the same administrator account that started this request. Your current session has not changed.")
        }
        else if (stepUpLogin && failureCode === "step_up_expired") {
          setError("This re-authentication request has expired. Return to Manage users and try again.")
        }
        else if (failureCode === "account_action_required") setError("Your account needs an additional security action. Contact your administrator to complete it before signing in.")
        else if (failureCode === "service_unavailable" || errorCode === "Configuration") setError("Sign-in is temporarily unavailable. Please try again later.")
        else setError("Unable to sign in. Check your username, password, and authenticator code if you use one.")
        return
      }

      window.location.assign(destination.href)
      navigating = true
    } catch {
      setError("Sign-in is temporarily unavailable. Please try again later.")
    } finally {
      setPassword("")
      setOtp("")
      if (!navigating) {
        setSubmitting(false)
        pending.current = false
      }
    }
  }

  async function beginCompanySignIn() {
    // Admin re-authentication must prove the same account with a fresh
    // credential check. Keep the federated route off that flow.
    if (stepUpLogin || pending.current) return
    pending.current = true
    setError(null)
    setSubmitting(true)
    try {
      await signIn("keycloak", { redirectTo })
    } catch {
      setError("Company sign-in could not be started. Try again or use your InOut credentials.")
      setSubmitting(false)
      pending.current = false
    }
  }

  async function completeRequiredProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    if (pending.current) return
    pending.current = true
    setError(null)
    setSuccess(null)
    setSubmitting(true)
    let completed = false
    try {
      const csrfToken = await getCsrfToken()
      if (!csrfToken) throw new Error("Profile setup could not be prepared.")
      const response = await fetch("/api/auth/profile/complete", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, currentPassword: password, email, firstName, lastName, otp, csrfToken }),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setError(response.status === 429 ? "Too many attempts. Wait a minute and try again."
          : result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error : "Unable to update your profile. Please try again.")
        return
      }
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        throw new Error("Profile setup was not confirmed.")
      }
      setProfileSetupRequired(false)
      setSuccess("Profile updated. Sign in again to continue.")
      completed = true
    } catch {
      setError("Unable to update your profile. Please try again.")
    } finally {
      setPassword("")
      setOtp("")
      if (completed) {
        setEmail("")
        setFirstName("")
        setLastName("")
      }
      setSubmitting(false)
      pending.current = false
    }
  }

  async function updateTemporaryPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    if (pending.current) return
    setError(null)
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.")
      return
    }
    if (newPassword === password) {
      setError("Choose a new password different from your temporary password.")
      return
    }
    pending.current = true
    setSuccess(null)
    setSubmitting(true)
    try {
      const csrfToken = await getCsrfToken()
      if (!csrfToken) throw new Error("Password setup could not be prepared.")
      const response = await fetch("/api/auth/password/update", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "setup", username, currentPassword: password,
          newPassword, confirmPassword, otp, csrfToken }),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setError(response.status === 429 ? "Too many attempts. Wait a minute and try again."
          : result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error : "Unable to update your password. Please try again.")
        return
      }
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        throw new Error("Password setup was not confirmed.")
      }
      setAccountSetupRequired(false)
      setSuccess("Password updated. Sign in with your new password.")
    } catch {
      setError("Unable to update your password. Please try again.")
    } finally {
      setPassword("")
      setOtp("")
      setNewPassword("")
      setConfirmPassword("")
      setSubmitting(false)
      pending.current = false
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    void beginSignIn()
  }

  return (
    <>
      {error && <div className={styles.errorBanner} role="alert">{error}</div>}
      {success && <div className={styles.successBanner} role="status">{success}</div>}
      {passwordSetupSignoutRequired && (
        <div className={styles.setupSignout}>
          <p className={styles.formHint}>Signing out ends the current app and organization login session. You can then sign in with the temporary account and continue its password setup.</p>
          <form action="/logout" method="post">
            <button type="submit" className={styles.button}>Sign out and return to sign in</button>
          </form>
        </div>
      )}
      {profileSetupRequired ? (
        <form className={styles.form} method="post" action="/api/auth/profile/complete" onSubmit={completeRequiredProfile} aria-busy={submitting}>
          <input type="hidden" name="username" autoComplete="username" value={username} />
          <p className={styles.formHint}>Complete the required profile details to finish setting up your account.</p>
          <p className={styles.formHint}>Account: <strong>{username}</strong></p>
          <label className={styles.field} htmlFor="profile-email">
            Email
            <input id="profile-email" name="email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={submitting} />
          </label>
          <label className={styles.field} htmlFor="profile-first-name">
            First name
            <input id="profile-first-name" name="firstName" type="text" required maxLength={256} autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} disabled={submitting} />
          </label>
          <label className={styles.field} htmlFor="profile-last-name">
            Last name
            <input id="profile-last-name" name="lastName" type="text" required maxLength={256} autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} disabled={submitting} />
          </label>
          <label className={styles.field} htmlFor="profile-current-password">
            Current password
            <input id="profile-current-password" name="currentPassword" type="password" required minLength={1} maxLength={128} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting} />
          </label>
          <details className={styles.authenticator}>
            <summary>Authenticator code</summary>
            <label className={styles.field} htmlFor="profile-otp">
              Code
              <input id="profile-otp" name="otp" type="text" inputMode="numeric" pattern="[0-9]{6,8}" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} disabled={submitting} />
            </label>
          </details>
          <button type="submit" className={styles.button} disabled={submitting}>
            {submitting ? "Updating profile…" : "Save profile and continue"}
          </button>
          <button type="button" className={styles.recoveryLink} disabled={submitting} onClick={() => {
            setProfileSetupRequired(false)
            setError(null)
            setPassword("")
            setOtp("")
            setEmail("")
            setFirstName("")
            setLastName("")
            setSubmitting(false)
            pending.current = false
          }}>
            Back to sign in
          </button>
        </form>
      ) : accountSetupRequired ? (
        <form className={styles.form} method="post" action="/api/auth/password/update" onSubmit={updateTemporaryPassword} aria-busy={submitting}>
          <input type="hidden" name="username" autoComplete="username" value={username} />
          <p className={styles.formHint}>Set a new password to finish signing in.</p>
          <p className={styles.formHint}>Account: <strong>{username}</strong></p>
          <label className={styles.field} htmlFor="setup-current-password">
            Temporary password
            <input id="setup-current-password" name="currentPassword" type="password" required minLength={1} maxLength={128} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting} />
          </label>
          <label className={styles.field} htmlFor="setup-new-password">
            New password
            <input id="setup-new-password" name="newPassword" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" placeholder="At least 12 characters" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={submitting} />
          </label>
          <label className={styles.field} htmlFor="setup-confirm-password">
            Confirm new password
            <input id="setup-confirm-password" name="confirmPassword" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={submitting} />
          </label>
          <details className={styles.authenticator}>
            <summary>Authenticator code</summary>
            <label className={styles.field} htmlFor="setup-otp">
              Code
              <input id="setup-otp" name="otp" type="text" inputMode="numeric" pattern="[0-9]{6,8}" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} disabled={submitting} />
            </label>
          </details>
          <button type="submit" className={styles.button} disabled={submitting}>
            {submitting ? "Updating password…" : "Change temporary password"}
          </button>
          <button type="button" className={styles.recoveryLink} disabled={submitting} onClick={() => {
            setAccountSetupRequired(false)
            setError(null)
            setSuccess(null)
            setPassword("")
            setOtp("")
            setNewPassword("")
            setConfirmPassword("")
            setSubmitting(false)
            pending.current = false
          }}>
            Back to sign in
          </button>
        </form>
      ) : (
      <>
      <form className={styles.form} method="post" action="/api/auth/callback/credentials" onSubmit={submit} aria-busy={submitting}>
        <label className={styles.field} htmlFor="login-username">
          Email or username
          <input id="login-username" name="username" type="text" required maxLength={254} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} disabled={submitting} />
        </label>
        <label className={styles.field} htmlFor="login-password">
          Password
          <input id="login-password" name="password" type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting} />
        </label>
        <details className={styles.authenticator}>
          <summary>Authenticator code</summary>
          <label className={styles.field} htmlFor="login-otp">
            Code
            <input id="login-otp" name="otp" type="text" inputMode="numeric" pattern="[0-9]{6,8}" maxLength={8} autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} disabled={submitting} />
          </label>
        </details>
        {stepUpLogin && <StepUpDurationSelect value={durationMinutes} onChange={setDurationMinutes} disabled={submitting} />}
        <button type="submit" className={styles.button} disabled={submitting}>
          {submitting ? "Signing in…" : stepUpLogin ? "Re-authenticate" : "Sign in"}
        </button>
        {stepUpLogin ? <Link className={styles.returnButton} href="/admin/dashboard">Return to dashboard</Link> : null}
      </form>
      {!stepUpLogin && !passwordSetupSignoutRequired && (
        <div className={styles.ssoSection}>
          <div className={styles.ssoDivider}><span>or</span></div>
          <button type="button" className={styles.ssoButton} onClick={() => void beginCompanySignIn()} disabled={submitting}>
            {submitting ? "Connecting…" : "Continue with Zoho"}
          </button>
        </div>
      )}
      </>
      )}
    </>
  )
}
