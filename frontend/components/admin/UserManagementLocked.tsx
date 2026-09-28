"use client";

import { useState } from "react";
import { LockKeyhole, Unlock } from "lucide-react";
import { signIn } from "next-auth/react";

export function UserManagementLocked() {
  const [message, setMessage] = useState("");
  async function unlock() {
    setMessage("");
    try {
      const response = await fetch("/api/auth/step-up", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Unable to start re-authentication.");
      await signIn("keycloak", { redirectTo: "/admin/users" }, { prompt: "login", max_age: "0" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start re-authentication.");
    }
  }
  return <main className="identity-workspace identity-workspace-flat" aria-label="Locked user management"><section className="identity-locked"><LockKeyhole aria-hidden="true" /><div><span className="eyebrow">Protected area</span><h1>Manage users is locked</h1><p>Unlock with a fresh Keycloak sign-in to create, edit, or secure user accounts.</p>{message ? <p className="identity-status" role="status">{message}</p> : null}<button className="primary-button" type="button" onClick={() => void unlock()}><Unlock aria-hidden="true" /> Unlock user management</button></div></section></main>;
}
