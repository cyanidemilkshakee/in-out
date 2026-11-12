"use client";

import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../../../lib/passwordLimits";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getCsrfToken } from "next-auth/react";
import { BadgeCheck, KeyRound, LoaderCircle, ShieldCheck, UserRound } from "lucide-react";
import styles from "./AccountCenter.module.css";
import { KEYCLOAK_REQUIRED_ACTIONS, type KeycloakRequiredAction } from "../../../lib/keycloakRequiredActions";

type AccountProfile = { username: string; firstName: string; lastName: string; email: string; emailVerified: boolean; locale: string };
type Credential = { id: string; type: string; label: string; createdDate?: number };
type AccountData = { profile: AccountProfile; credentials: Credential[]; supportedLocales: string[]; requiredActions: string[]; identityProviders: Array<{ alias: string; label: string }> };
type Notice = { kind: "success" | "error"; text: string } | null;
type TotpSetup = { secret: string; otpAuthUri: string; digits: number; period: number };

const PREVIEW_DATA: AccountData = {
  profile: { username: "preview.user", firstName: "Sample", lastName: "User", email: "user@example.test", emailVerified: false, locale: "en" },
  credentials: [
    { id: "preview-authenticator", type: "otp", label: "Authenticator app" },
    { id: "preview-passkey", type: "webauthn", label: "Work laptop" },
    { id: "preview-recovery", type: "recovery-authn-codes", label: "Recovery codes" },
  ],
  supportedLocales: ["en", "fr", "hi"],
  requiredActions: KEYCLOAK_REQUIRED_ACTIONS.map(({ id }) => id),
  identityProviders: [],
};

function readableCredentialType(type: string) {
  const labels: Record<string, string> = {
    password: "Password", otp: "Authenticator", webauthn: "Security key or passkey",
    "webauthn-passwordless": "Passwordless passkey", "recovery-authn-codes": "Recovery codes",
  };
  return labels[type] ?? type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AccountCenter() {
  const [data, setData] = useState<AccountData | null>(PREVIEW_DATA);
  const loading = false;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [passwordNotice, setPasswordNotice] = useState<Notice>(null);
  const [passwordUpdate, setPasswordUpdate] = useState({ username: "", currentPassword: "", newPassword: "", confirmPassword: "", otp: "" });
  const passwordPending = useRef(false);
  const [profile, setProfile] = useState({ firstName: "", lastName: "", email: "", locale: "" });
  const [securityProof, setSecurityProof] = useState({ password: "", otp: "" });
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpLabel, setTotpLabel] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});

  function load(showNotice = true) {
    setData(PREVIEW_DATA);
    setProfile({ firstName: PREVIEW_DATA.profile.firstName, lastName: PREVIEW_DATA.profile.lastName, email: PREVIEW_DATA.profile.email, locale: PREVIEW_DATA.profile.locale });
    setLabels(Object.fromEntries(PREVIEW_DATA.credentials.map(({ id, label }) => [id, label])));
    if (showNotice) setNotice({ kind: "success", text: "Preview reset. No identity-provider data was read or written." });
  }

  useEffect(() => {
    load(false);
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      setData((current) => current ? { ...current, profile: { ...current.profile, ...profile } } : current);
      setNotice({ kind: "success", text: "Profile preview updated locally. It was not sent to an identity provider." });
    } finally { setBusy(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || busy || passwordPending.current) return;
    setPasswordNotice(null);
    if (passwordUpdate.newPassword !== passwordUpdate.confirmPassword) {
      setPasswordNotice({ kind: "error", text: "The new passwords do not match." });
      return;
    }
    if (passwordUpdate.newPassword === passwordUpdate.currentPassword) {
      setPasswordNotice({ kind: "error", text: "Choose a new password different from your current password." });
      return;
    }
    passwordPending.current = true;
    setBusy(true); setNotice(null);
    try {
      const csrfToken = await getCsrfToken();
      if (!csrfToken) throw new Error("Password change could not be prepared.");
      const response = await fetch("/api/auth/password/update", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "change", ...passwordUpdate, csrfToken }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setPasswordNotice({ kind: "error", text: response.status === 429 ? "Too many attempts. Wait a minute and try again."
          : result && typeof result === "object" && "error" in result && typeof result.error === "string"
            ? result.error : "Unable to update your password. Please try again." });
        return;
      }
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        throw new Error("Password change was not confirmed.");
      }
      setPasswordNotice({ kind: "success", text: "Your password was updated successfully." });
    } catch {
      setPasswordNotice({ kind: "error", text: "Unable to update your password. Please try again." });
    } finally {
      setPasswordUpdate((current) => ({ ...current, currentPassword: "", newPassword: "", confirmPassword: "", otp: "" }));
      passwordPending.current = false;
      setBusy(false);
    }
  }

  async function saveCredentialLabel() {
    setBusy(true); setNotice(null);
    try {
      setNotice({ kind: "success", text: "Credential name preview updated locally. It was not sent to an identity provider." });
    } finally { setBusy(false); }
  }

  async function removeCredential(credential: Credential) {
    if (!data?.requiredActions.includes("delete_credential")) return;
    setBusy(true); setNotice(null);
    try {
      setData((current) => current ? { ...current, credentials: current.credentials.filter((item) => item.id !== credential.id) } : current);
      setSecurityProof({ password: "", otp: "" });
      setNotice({ kind: "success", text: "Credential removed from this preview only. The identity provider was not changed." });
    } finally { setBusy(false); }
  }

  async function sendVerificationEmail() {
    setBusy(true); setNotice(null);
    try {
      setNotice({ kind: "success", text: "Email verification preview only. No message was sent." });
    } finally { setBusy(false); }
  }

  function completeRequiredAction(action: string) {
    if (action === "UPDATE_PROFILE" || action === "VERIFY_PROFILE" || action === "update_user_locale") {
      document.getElementById("profile-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "VERIFY_EMAIL") {
      void sendVerificationEmail();
      return;
    }
    if (action === "UPDATE_PASSWORD") {
      document.getElementById("password-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "CONFIGURE_TOTP") {
      document.getElementById("totp-setup-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "CONFIGURE_RECOVERY_AUTHN_CODES") {
      document.getElementById("recovery-codes-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "delete_credential") {
      document.getElementById("credentials-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (action === "webauthn-register" || action === "webauthn-register-passwordless") {
      document.getElementById("passkey-setup-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  async function beginTotpSetup() {
    setBusy(true); setNotice(null);
    setTotpSetup({ secret: "PREVIEW ONLY", otpAuthUri: "otpauth://totp/Preview?secret=PREVIEWONLY", digits: 6, period: 30 });
    setNotice({ kind: "success", text: "Authenticator setup preview only. The sample secret is not valid and was not saved." });
    setBusy(false);
  }

  async function finishTotpSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      setNotice({ kind: "success", text: "Authenticator form preview complete. No credential was created." });
      setTotpSetup(null); setTotpCode(""); setTotpLabel(""); setSecurityProof({ password: "", otp: "" });
    } finally { setBusy(false); }
  }

  async function makeRecoveryCodes() {
    setBusy(true); setNotice(null);
    try {
      setRecoveryCodes(["PREVIEW-ONLY-0001", "PREVIEW-ONLY-0002", "PREVIEW-ONLY-0003", "PREVIEW-ONLY-0004"]);
      setSecurityProof({ password: "", otp: "" });
      setNotice({ kind: "success", text: "Sample codes only. They cannot recover an account and were not saved." });
    } finally { setBusy(false); }
  }

  async function addPasskey(credentialKind: "second-factor" | "passwordless") {
    setBusy(true); setNotice(null);
    setNotice({ kind: "success", text: `${credentialKind === "passwordless" ? "Passwordless passkey" : "Security key or passkey"} setup preview only. No browser credential was created.` });
    setBusy(false);
  }

  function actionDetails(action: string) {
    return KEYCLOAK_REQUIRED_ACTIONS.find((item) => item.id === action as KeycloakRequiredAction);
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <span className={styles.headerIcon}><ShieldCheck size={24} aria-hidden="true" /></span>
      <div><p className={styles.eyebrow}>INOUT ACCOUNT</p><h1>Account and security</h1><p>Manage your password and preview other account controls.</p></div>
    </header>
    <p className={styles.hint}>Change your password here. Other account controls on this page use sample data and remain previews.</p>
    {notice ? <p className={styles.notice} data-kind={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}
    {loading ? <p className={styles.loading}><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />Loading account…</p> : data ? <>
      {data.requiredActions.length ? <section className={styles.card} aria-labelledby="required-actions-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><ShieldCheck size={21} aria-hidden="true" /></span><div><h2 id="required-actions-title">Account setup preview</h2><p>Sample action list. Update your password below; other actions remain previews.</p></div></div>
        <ul className={styles.requiredActions}>{data.requiredActions.map((action) => {
          const details = actionDetails(action);
          return <li className={styles.requiredAction} key={action}><div><strong>{details?.label ?? action}</strong><span>{details?.description ?? "Complete this security requirement."}</span></div>{action === "idp_link" ? <span className={styles.hint}>Choose an identity provider below</span> : <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => completeRequiredAction(action)}>{action === "VERIFY_EMAIL" ? "Send email" : action === "UPDATE_PROFILE" || action === "VERIFY_PROFILE" || action === "update_user_locale" ? "Review" : action === "UPDATE_PASSWORD" ? "Update" : "Open"}</button>}</li>;
        })}</ul>
      </section> : null}
      <section className={styles.card} aria-labelledby="profile-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><UserRound size={21} aria-hidden="true" /></span><div><h2 id="profile-title">Profile preview</h2><p>Edits stay in this page and are not saved to the identity provider. @{data.profile.username}</p></div></div>
        <form className={styles.form} onSubmit={saveProfile} aria-busy={busy}>
          <div className={styles.twoColumn}>
            <label className={styles.field}><span>First name</span><input required maxLength={100} autoComplete="given-name" value={profile.firstName} onChange={(event) => setProfile((value) => ({ ...value, firstName: event.target.value }))} disabled={busy} /></label>
            <label className={styles.field}><span>Last name</span><input required maxLength={100} autoComplete="family-name" value={profile.lastName} onChange={(event) => setProfile((value) => ({ ...value, lastName: event.target.value }))} disabled={busy} /></label>
            <label className={styles.field}><span>Email address</span><input type="email" maxLength={320} autoComplete="email" value={profile.email} onChange={(event) => setProfile((value) => ({ ...value, email: event.target.value }))} disabled={busy} /></label>
            {data.supportedLocales.length ? <label className={styles.field}><span>Language</span><select value={profile.locale} onChange={(event) => setProfile((value) => ({ ...value, locale: event.target.value }))} disabled={busy}><option value="">Default language</option>{data.supportedLocales.map((locale) => <option value={locale} key={locale}>{locale}</option>)}</select></label> : null}
          </div>
          <div className={styles.emailRow}><span>Email</span><strong>{data.profile.email || "No email address"}</strong><span className={styles.verification} data-verified={data.profile.emailVerified}>{data.profile.emailVerified ? <><BadgeCheck size={16} aria-hidden="true" />Verified</> : "Not verified"}</span></div>
          {!data.profile.emailVerified && data.profile.email ? <div className={styles.verifyRow}><p className={styles.hint}>Email verification is required before this address can be treated as verified.</p><button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void sendVerificationEmail()}>Preview email verification</button></div> : null}
          <button className={styles.primaryButton} type="submit" disabled={busy}>{busy ? "Saving preview…" : "Save preview"}</button>
        </form>
      </section>

      <section className={styles.card} aria-labelledby="password-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><KeyRound size={21} aria-hidden="true" /></span><div><h2 id="password-title">Password</h2><p>Verify your current password and choose a new one.</p></div></div>
        <form className={styles.form} method="post" action="/api/auth/password/update" onSubmit={changePassword} aria-busy={busy}>
          {passwordNotice ? <p className={styles.notice} data-kind={passwordNotice.kind} role={passwordNotice.kind === "error" ? "alert" : "status"}>{passwordNotice.text}</p> : null}
          <label className={styles.field}><span>Email or username</span><input name="username" required maxLength={254} autoComplete="username" autoCapitalize="none" spellCheck={false} value={passwordUpdate.username} onChange={(event) => setPasswordUpdate((value) => ({ ...value, username: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Current password</span><input name="currentPassword" type="password" required minLength={1} maxLength={128} autoComplete="current-password" value={passwordUpdate.currentPassword} onChange={(event) => setPasswordUpdate((value) => ({ ...value, currentPassword: event.target.value }))} disabled={busy} /></label>
          <div className={styles.twoColumn}>
            <label className={styles.field}><span>New password</span><input name="newPassword" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" placeholder="At least 12 characters" value={passwordUpdate.newPassword} onChange={(event) => setPasswordUpdate((value) => ({ ...value, newPassword: event.target.value }))} disabled={busy} /></label>
            <label className={styles.field}><span>Confirm new password</span><input name="confirmPassword" type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={passwordUpdate.confirmPassword} onChange={(event) => setPasswordUpdate((value) => ({ ...value, confirmPassword: event.target.value }))} disabled={busy} /></label>
          </div>
          <label className={styles.field}><span>Authenticator code <small>(if configured)</small></span><input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={passwordUpdate.otp} onChange={(event) => setPasswordUpdate((value) => ({ ...value, otp: event.target.value }))} disabled={busy} /></label>
          <div className={styles.buttonRow}>
            <button className={styles.primaryButton} type="submit" disabled={busy}>{busy ? "Updating password…" : "Update password"}</button>
            <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => {
              setPasswordUpdate({ username: "", currentPassword: "", newPassword: "", confirmPassword: "", otp: "" });
              setPasswordNotice(null);
            }}>Clear</button>
          </div>
        </form>
      </section>

      <section className={styles.card} aria-labelledby="totp-setup-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><KeyRound size={21} aria-hidden="true" /></span><div><h2 id="totp-setup-title">Authenticator app</h2><p>Preview enrollment of a time-based one-time password.</p></div></div>
        {!totpSetup ? <div className={styles.form}>
          <label className={styles.field}><span>Current password</span><input type="password" autoComplete="current-password" value={securityProof.password} onChange={(event) => setSecurityProof((value) => ({ ...value, password: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Current authenticator code <small>(if already configured)</small></span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={securityProof.otp} onChange={(event) => setSecurityProof((value) => ({ ...value, otp: event.target.value }))} disabled={busy} /></label>
          <button className={styles.secondaryButton} type="button" disabled={busy || !securityProof.password} onClick={() => void beginTotpSetup()}>Start authenticator setup</button>
        </div> : <form className={styles.form} onSubmit={finishTotpSetup}>
          <p className={styles.hint}>Authenticator secret</p><code className={styles.secret}>{totpSetup.secret}</code>
          <label className={styles.field}><span>Authenticator URI</span><input readOnly value={totpSetup.otpAuthUri} onFocus={(event) => event.currentTarget.select()} /></label>
          <label className={styles.field}><span>Device name</span><input maxLength={100} value={totpLabel} onChange={(event) => setTotpLabel(event.target.value)} disabled={busy} /></label>
          <label className={styles.field}><span>Code from authenticator</span><input required inputMode="numeric" autoComplete="one-time-code" pattern={`[0-9]{${totpSetup.digits}}`} maxLength={totpSetup.digits} value={totpCode} onChange={(event) => setTotpCode(event.target.value)} disabled={busy} /></label>
          <div className={styles.buttonRow}><button className={styles.primaryButton} type="submit" disabled={busy || !totpCode}>Verify and add</button><button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setTotpSetup(null)}>Cancel</button></div>
        </form>}
      </section>

      <section className={styles.card} aria-labelledby="recovery-codes-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><ShieldCheck size={21} aria-hidden="true" /></span><div><h2 id="recovery-codes-title">Recovery-code preview</h2><p>Sample codes only; they cannot recover an account and are not saved.</p></div></div>
        {recoveryCodes ? <><p className={styles.hint}>Each code can be used once. Save this list now; it will not be shown again.</p><div className={styles.recoveryCodes}>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className={styles.secondaryButton} type="button" onClick={() => setRecoveryCodes(null)}>Hide codes</button></> : <div className={styles.form}>
          <label className={styles.field}><span>Current password</span><input type="password" autoComplete="current-password" value={securityProof.password} onChange={(event) => setSecurityProof((value) => ({ ...value, password: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Current authenticator code <small>(if configured)</small></span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={securityProof.otp} onChange={(event) => setSecurityProof((value) => ({ ...value, otp: event.target.value }))} disabled={busy} /></label>
          <button className={styles.secondaryButton} type="button" disabled={busy || !securityProof.password} onClick={() => void makeRecoveryCodes()}>Preview recovery codes</button>
        </div>}
      </section>

      <section className={styles.card} aria-labelledby="passkey-setup-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><KeyRound size={21} aria-hidden="true" /></span><div><h2 id="passkey-setup-title">Security keys and passkeys</h2><p>Preview the registration form for a key or passkey.</p></div></div>
        <div className={styles.form}>
          <label className={styles.field}><span>Current password</span><input type="password" autoComplete="current-password" value={securityProof.password} onChange={(event) => setSecurityProof((value) => ({ ...value, password: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Current authenticator code <small>(if enabled)</small></span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={securityProof.otp} onChange={(event) => setSecurityProof((value) => ({ ...value, otp: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Passkey name</span><input maxLength={100} value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} disabled={busy} placeholder="For example, Work laptop" /></label>
          <div className={styles.buttonRow}><button className={styles.secondaryButton} type="button" disabled={busy || !securityProof.password} onClick={() => void addPasskey("second-factor")}>Preview security key or passkey</button><button className={styles.secondaryButton} type="button" disabled={busy || !securityProof.password} onClick={() => void addPasskey("passwordless")}>Preview passwordless passkey</button></div>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="identity-provider-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><ShieldCheck size={21} aria-hidden="true" /></span><div><h2 id="identity-provider-title">Identity providers</h2><p>Link an organization sign-in method to this account.</p></div></div>
        <div className={styles.form}><p className={styles.hint}>The organization has not selected an identity provider yet. This area is reserved for the provider picker and link status.</p><button className={styles.secondaryButton} type="button" disabled>Choose provider (not configured)</button></div>
      </section>

      <section className={styles.card} aria-labelledby="credentials-title">
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><KeyRound size={21} aria-hidden="true" /></span><div><h2 id="credentials-title">Sign-in methods</h2><p>Preview credential list and removal controls.</p></div></div>
        {data.requiredActions.includes("delete_credential") ? <div className={styles.form}>
          <p className={styles.hint}>Your administrator requires an existing sign-in method to be removed. Confirm your current password first.</p>
          <label className={styles.field}><span>Current password</span><input type="password" autoComplete="current-password" value={securityProof.password} onChange={(event) => setSecurityProof((value) => ({ ...value, password: event.target.value }))} disabled={busy} /></label>
          <label className={styles.field}><span>Current authenticator code <small>(if enabled)</small></span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,8}" maxLength={8} value={securityProof.otp} onChange={(event) => setSecurityProof((value) => ({ ...value, otp: event.target.value }))} disabled={busy} /></label>
        </div> : null}
        {data.credentials.length ? <div className={styles.credentials}>{data.credentials.map((credential) => <div className={styles.credential} key={credential.id}>
          <div><strong>{readableCredentialType(credential.type)}</strong><label className={styles.field}><span>Credential name</span><input maxLength={100} value={labels[credential.id] ?? ""} onChange={(event) => setLabels((current) => ({ ...current, [credential.id]: event.target.value }))} disabled={busy} /></label></div>
          <div className={styles.buttonRow}><button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void saveCredentialLabel()}>Preview name change</button>{data.requiredActions.includes("delete_credential") && credential.type !== "password" ? <button className={styles.secondaryButton} type="button" disabled={busy || !securityProof.password} onClick={() => void removeCredential(credential)}>Preview removal</button> : null}</div>
        </div>)}</div> : <p className={styles.empty}>No sign-in credentials are available to display.</p>}
      </section>
    </> : <button className={styles.secondaryButton} type="button" onClick={() => void load()}>Try again</button>}
  </main>;
}
