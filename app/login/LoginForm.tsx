"use client"

import { useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { getCsrfToken } from "next-auth/react"
import { PasswordRequirements } from "../../frontend/components/PasswordRequirements"
import { StepUpDurationSelect } from "../../frontend/components/admin/StepUpDurationSelect"
import { DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, type StepUpDurationMinutes } from "../../lib/userManagementStepUp"
import { isPasswordValid, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE } from "../../lib/passwordPolicy"
import { LOGIN_FAILURE_MESSAGE } from "../../lib/loginMessages"
import styles from "./login.module.css"

type LoginFormProps = {
  redirectTo: string
  stepUpLogin: boolean
  initialError?: string
  initialDurationMinutes?: StepUpDurationMinutes
}

export default function LoginForm({ redirectTo, stepUpLogin, initialError, initialDurationMinutes = DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES }: LoginFormProps) {
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [submitting, setSubmitting] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [otp, setOtp] = useState("")
  const [accountSetupRequired, setAccountSetupRequired] = useState(false)
  const [newPassword, setNewPassword] = useState("")
  const [confirmNewPassword, setConfirmNewPassword] = useState("")
  const [durationMinutes, setDurationMinutes] = useState<StepUpDurationMinutes>(initialDurationMinutes)
  const pending = useRef(false)

  async function beginSignIn() {
    if (pending.current) return
    pending.current = true
    setError(null)
    setAccountSetupRequired(false)
    let preserveCredentials = false
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
        body: new URLSearchParams({ username, password, otp, csrfToken, callbackUrl: redirectTo, ...(stepUpLogin ? { stepUp: "1" } : {}) }),
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
        if (failureCode === "step_up_account_mismatch") {
          setError("Re-authenticate with the same administrator account that started this request. Your current administrator session has not changed.")
        }
        else if (failureCode === "step_up_expired") {
          setError("This re-authentication request has expired. Return to Manage users and try again.")
        }
        else if (failureCode === "account_setup_required" && stepUpLogin) {
          setError("Account setup cannot be completed during administrator re-authentication. Use the administrator account that started this request; your current administrator session has not changed.")
        }
        else if (failureCode === "account_setup_required") {
          setAccountSetupRequired(true)
          preserveCredentials = true
          setError("Choose a new password to finish setting up your account.")
        }
        else if (failureCode === "service_unavailable" || errorCode === "Configuration") setError("Sign-in is temporarily unavailable. Please try again later.")
        else setError(LOGIN_FAILURE_MESSAGE)
        return
      }

      window.location.assign(destination.href)
      navigating = true
    } catch {
      setError("Sign-in is temporarily unavailable. Please try again later.")
    } finally {
      if (!preserveCredentials) {
        setPassword("")
        setOtp("")
      }
      if (!navigating) {
        setSubmitting(false)
        pending.current = false
      }
    }
  }

  async function completeAccountSetup() {
    if (pending.current) return
    pending.current = true
    setSubmitting(true)
    setError(null)
    let navigating = false
    try {
      const setupResponse = await fetch("/api/auth/account-setup", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, currentPassword: password, otp, newPassword }),
      })
      const setupResult = await setupResponse.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!setupResponse.ok || setupResult?.ok !== true) throw new Error(setupResult?.error ?? "Account setup is temporarily unavailable.")
      // The temporary password is no longer valid after this point. Keep the
      // new password in the sign-in form if any later step needs to be retried.
      setPassword(newPassword)
      setAccountSetupRequired(false)
      setNewPassword("")
      setConfirmNewPassword("")
      if (stepUpLogin) {
        const prepared = await fetch("/api/auth/step-up", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationMinutes }),
        })
        if (!prepared.ok) throw new Error("Unable to prepare re-authentication. Please try again.")
      }
      const csrfToken = await getCsrfToken()
      if (!csrfToken) throw new Error("Sign-in could not be prepared.")
      const response = await fetch("/api/auth/callback/credentials", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
        body: new URLSearchParams({ username, password: newPassword, otp, csrfToken, callbackUrl: redirectTo,
          ...(stepUpLogin ? { stepUp: "1" } : {}) }),
      })
      if (!response.ok) throw new Error("Your password was updated, but sign-in could not be completed. Sign in with the new password.")
      const result = await response.json().catch(() => null) as { url?: string } | null
      if (typeof result?.url !== "string") throw new Error("Your password was updated, but sign-in could not be completed. Sign in with the new password.")
      const destination = new URL(result.url, window.location.origin)
      if (destination.origin !== window.location.origin || destination.username || destination.password) throw new Error("Sign-in response is invalid.")
      if (destination.searchParams.has("error")) throw new Error("Your password was updated, but sign-in could not be completed. Sign in with the new password.")
      window.location.assign(destination.href)
      navigating = true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account setup is temporarily unavailable. Please try again.")
    } finally {
      if (!navigating) {
        setSubmitting(false)
        pending.current = false
      }
    }
  }

  function submitAccountSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    if (!isPasswordValid(newPassword)) {
      setError(PASSWORD_POLICY_MESSAGE)
      return
    }
    if (newPassword !== confirmNewPassword) {
      setError("The new passwords do not match.")
      return
    }
    void completeAccountSetup()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) return
    void beginSignIn()
  }

  return (
    <>
      {error && <div className={styles.errorBanner} role="alert">{error}</div>}
      <form className={styles.form} method="post" action="/api/auth/callback/credentials" onSubmit={submit} aria-busy={submitting}>
        {stepUpLogin && <input type="hidden" name="stepUp" value="1" />}
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
      </form>
      {accountSetupRequired && (
        <form className={styles.setupForm} onSubmit={submitAccountSetup} aria-busy={submitting}>
          <label className={styles.field} htmlFor="login-new-password">
            New password
            <input id="login-new-password" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={submitting} />
          </label>
          <PasswordRequirements value={newPassword} />
          <label className={styles.field} htmlFor="login-confirm-new-password">
            Confirm new password
            <input id="login-confirm-new-password" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} disabled={submitting} />
          </label>
          <button type="submit" className={styles.button} disabled={submitting}>
            {submitting ? "Completing setup…" : "Set password and continue"}
          </button>
        </form>
      )}
      {stepUpLogin && <Link className={styles.homeButton} href="/admin">Go to dashboard</Link>}
    </>
  )
}
