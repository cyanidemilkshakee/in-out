"use client"

import { useRef, useState, type FormEvent } from "react"
import { getCsrfToken, signIn } from "next-auth/react"
import { StepUpDurationSelect } from "../../frontend/components/admin/StepUpDurationSelect"
import { DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, type StepUpDurationMinutes } from "../../lib/userManagementStepUp"
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
  const [durationMinutes, setDurationMinutes] = useState<StepUpDurationMinutes>(initialDurationMinutes)
  const pending = useRef(false)

  async function beginSignIn() {
    if (pending.current) return
    pending.current = true
    setError(null)
    setAccountSetupRequired(false)
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
          setAccountSetupRequired(true)
          setError("Complete your account's password or security setup to continue.")
        }
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

  async function completeAccountSetup() {
    if (pending.current) return
    pending.current = true
    setSubmitting(true)
    try {
      const result = await signIn("keycloak", { redirectTo, redirect: false }, { prompt: "login", max_age: "0" })
      if (!result?.url || result.error) throw new Error("Account setup is unavailable.")
      window.location.assign(result.url)
    } catch {
      setError("Account setup is temporarily unavailable. Please try again later.")
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
      </form>
      {accountSetupRequired && (
        <button type="button" className={styles.recoveryLink} disabled={submitting} onClick={() => void completeAccountSetup()}>
          Complete account setup
        </button>
      )}
    </>
  )
}
