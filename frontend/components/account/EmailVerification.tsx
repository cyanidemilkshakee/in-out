"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, LoaderCircle, ShieldCheck } from "lucide-react";
import styles from "./AccountCenter.module.css";

export function EmailVerification() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = fragment.get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    if (/^[A-Za-z0-9_-]{40,64}$/.test(value)) setToken(value);
    else setToken("preview-token");
  }, []);

  async function verify() {
    if (!token || busy) return;
    setBusy(true); setError("");
    try {
      setDone(true); setToken("");
      setError("");
    } finally { setBusy(false); }
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <span className={styles.headerIcon}>{done ? <BadgeCheck size={24} aria-hidden="true" /> : <ShieldCheck size={24} aria-hidden="true" />}</span>
      <div><p className={styles.eyebrow}>INOUT ACCOUNT</p><h1>Verify your email</h1><p>Confirm that you can access the email address on your account.</p></div>
    </header>
    <p className={styles.hint}>UI preview only. This page does not verify or update an account.</p>
    <section className={styles.card} aria-live="polite">
      {done ? <><h2>Preview complete</h2><p className={styles.hint}>No email status was changed. Return to InOut when ready.</p><a className={styles.secondaryButton} href="/account">Return to account</a></>
        : error ? <><h2>Verification not completed</h2><p className={styles.notice} data-kind="error" role="alert">{error}</p><a className={styles.secondaryButton} href="/login">Return to InOut</a></>
          : <><h2>Confirm this email address</h2><p className={styles.hint}>Select the button to preview the confirmation state.</p><button className={styles.primaryButton} type="button" disabled={!token || busy} onClick={() => void verify()}>{busy ? <><LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />Continuing…</> : "Preview confirmation"}</button></>}
    </section>
  </main>;
}
