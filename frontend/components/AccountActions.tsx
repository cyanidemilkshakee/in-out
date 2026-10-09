"use client"

import { useFormStatus } from "react-dom"
import { logout } from "../../app/authActions"
import styles from "./AccountActions.module.css"

function SignOutButton() {
  const { pending } = useFormStatus()
  return <button type="submit" disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>
}

export function AccountActions() {
  return (
    <div className={styles.actions} aria-label="Account actions">
      <a href="/account" target="_blank" rel="noopener noreferrer">Account security</a>
      <form action={logout}><SignOutButton /></form>
    </div>
  )
}
