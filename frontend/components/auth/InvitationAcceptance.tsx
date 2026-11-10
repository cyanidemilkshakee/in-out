"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight, Check, LoaderCircle, MailCheck, ShieldCheck } from "lucide-react";
import styles from "./InvitationAcceptance.module.css";

type Invite = { userId: string; token: string };

export function InvitationAcceptance() {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "accepting" | "accepted" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const userId = parameters.get("u") ?? "";
    const token = parameters.get("t") ?? "";
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!userId || !token) {
      setMessage("This invitation link is missing or incomplete. Ask your administrator to send a new one.");
      setState("error");
      return;
    }
    setInvite({ userId, token });
    setState("ready");
  }, []);

  async function accept() {
    if (!invite || state !== "ready") return;
    setState("accepting");
    setMessage("");
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invite),
      });
      const result = await response.json().catch(() => null) as { accepted?: unknown; error?: string } | null;
      if (!response.ok || result?.accepted !== true) {
        setMessage(result?.error ?? "This invitation could not be accepted. Ask your administrator to send a new one.");
        setState(response.status === 429 || response.status >= 500 ? "ready" : "error");
        return;
      }
      setInvite(null);
      setState("accepted");
    } catch {
      setMessage("The invitation service is unavailable. Try again in a moment.");
      setState("ready");
    }
  }

  return <main className={styles.page}>
    <section className={styles.card} aria-labelledby="invite-title">
      <div className={styles.brand}><span><ShieldCheck size={22} aria-hidden="true" /></span>IN / OUT</div>
      <div className={styles.icon} data-state={state} aria-hidden="true">
        {state === "accepted" ? <Check size={28} /> : <MailCheck size={28} />}
      </div>
      <h1 id="invite-title">{state === "accepted" ? "Invitation accepted" : "You’re invited to InOut"}</h1>
      {state === "accepted" ? <p className={styles.description}>Your account is ready. Continue with your company sign-in.</p>
        : <p className={styles.description}>Accept this invitation to activate your account, then sign in with Zoho.</p>}
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
      {state === "loading" ? <p className={styles.wait} role="status"><LoaderCircle size={17} />Checking invitation…</p> : null}
      {state === "ready" || state === "accepting" ? <button className={styles.primary} type="button" onClick={() => void accept()} disabled={state === "accepting"}>
        {state === "accepting" ? <><LoaderCircle size={17} className={styles.spin} />Accepting…</> : <>Accept invitation<ArrowRight size={17} /></>}
      </button> : null}
      {state === "accepted" ? <button className={styles.primary} type="button" onClick={() => void signIn("keycloak", { callbackUrl: "/admin/dashboard" })}>
        Continue with Zoho<ArrowRight size={17} />
      </button> : null}
      {state === "error" ? <a className={styles.secondary} href="/login">Return to sign in</a> : null}
      <p className={styles.footer}>This invitation is single-use and expires shortly.</p>
    </section>
  </main>;
}
