"use client";

import { useId, useState, type FormEventHandler } from "react";
import { Check, Eye, EyeOff, ScanLine, ShieldCheck } from "lucide-react";
import { FACILITY_ZONES } from "../../../lib/facilityZones";
import type { ManagedUser } from "../../../services/keycloakUserService";
import styles from "./ManagedUserForm.module.css";

export type ManagedUserFormValue = {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  temporaryPassword: boolean;
  enabled: boolean;
  roles: Array<"admin" | "operator">;
  checkpointId: ManagedUser["checkpointId"];
};

type FormProps = {
  form: ManagedUserFormValue;
  onChange: (form: ManagedUserFormValue) => void;
  busy: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

function IdentityFields({ form, onChange, creating }: Pick<FormProps, "form" | "onChange"> & { creating: boolean }) {
  return (
    <section className={styles.section} aria-label="Profile details">
      <div className={styles.twoColumn}>
        <label className={styles.field}><span>First name</span><input maxLength={100} autoComplete="given-name" value={form.firstName} onChange={(event) => onChange({ ...form, firstName: event.target.value })} /></label>
        <label className={styles.field}><span>Last name</span><input maxLength={100} autoComplete="family-name" value={form.lastName} onChange={(event) => onChange({ ...form, lastName: event.target.value })} /></label>
      </div>
      {creating ? <label className={styles.field}><span>Username</span><input required minLength={3} maxLength={64} pattern={"[A-Za-z0-9._\\-]+"} autoComplete="username" autoCapitalize="none" spellCheck={false} value={form.username} onChange={(event) => onChange({ ...form, username: event.target.value })} /></label> : null}
      <label className={styles.field}><span>Email</span><input type="email" maxLength={320} autoComplete="email" value={form.email} onChange={(event) => onChange({ ...form, email: event.target.value })} /></label>
    </section>
  );
}

function AccessFields({ form, onChange, showEnabled = true }: Pick<FormProps, "form" | "onChange"> & { showEnabled?: boolean }) {
  const operator = form.roles.includes("operator");
  const roles = [
    { value: "admin", title: "Admin", icon: ShieldCheck },
    { value: "operator", title: "Operator", icon: ScanLine },
  ] as const;

  return (
    <section className={styles.section} aria-label="Access settings">
      <div className={`${styles.accessFieldsRow} ${showEnabled ? styles.accessFieldsStack : ""}`}>
        <fieldset className={styles.roleFieldset}>
          <legend>Roles</legend>
          {showEnabled ? <label className={`${styles.toggle} ${styles.topToggle}`}><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /><strong>Enabled</strong></label> : null}
          <div className={styles.roles}>
            {roles.map(({ value, title, icon: Icon }) => {
              const checked = form.roles.includes(value);
              return <label key={value} className={styles.roleCard} data-selected={checked}>
                <input type="checkbox" checked={checked} onChange={(event) => onChange({ ...form, roles: event.target.checked ? [...form.roles, value] : form.roles.filter((role) => role !== value) })} />
                <span className={styles.roleIcon}><Icon size={21} aria-hidden="true" /></span>
                <strong className={styles.roleLabel}>{title}</strong>
                <span className={styles.roleCheck} aria-hidden="true">{checked ? <Check size={15} /> : null}</span>
              </label>;
            })}
          </div>
        </fieldset>
        <label className={`${styles.field} ${styles.checkpointField}`}><span>Checkpoint</span><select required={operator} value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: (event.target.value || null) as ManagedUser["checkpointId"] })}><option value="">Unassigned</option>{FACILITY_ZONES.map((zone) => <option key={zone.checkpointId} value={zone.checkpointId}>{zone.name}</option>)}</select></label>
      </div>
    </section>
  );
}

export function CreateUserForm({ form, onChange, busy, onSubmit, onCancel }: FormProps & { onCancel: () => void }) {
  const id = useId();
  const [showPassword, setShowPassword] = useState(false);

  return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
    <fieldset className={styles.fields} disabled={busy}>
      <div className={styles.creationGrid}>
        <IdentityFields form={form} onChange={onChange} creating />
        <AccessFields form={form} onChange={onChange} />
        <section className={`${styles.section} ${styles.passwordSection}`} aria-label="Password settings">
          <label className={styles.field} htmlFor={`${id}-new-password`}><span>Password</span></label>
          <div className={styles.passwordInput}><input id={`${id}-new-password`} required minLength={12} maxLength={128} type={showPassword ? "text" : "password"} autoComplete="new-password" value={form.password} onChange={(event) => onChange({ ...form, password: event.target.value })} placeholder="12+ characters" /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</button></div>
          <label className={styles.toggle}><input type="checkbox" checked={form.temporaryPassword} onChange={(event) => onChange({ ...form, temporaryPassword: event.target.checked })} /><strong>Change at sign-in</strong></label>
        </section>
      </div>
      <div className={styles.footer}><button className={styles.cancelButton} type="button" onClick={onCancel}>Cancel</button><button className={styles.submitButton} type="submit">Create user</button></div>
    </fieldset>
  </form>;
}

export function UserDetailsForm({ form, onChange, busy, onSubmit }: FormProps) {
  return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
    <fieldset className={styles.fields} disabled={busy}>
      <IdentityFields form={form} onChange={onChange} creating={false} />
      <AccessFields form={form} onChange={onChange} showEnabled={false} />
      <div className={styles.footer}><button className={styles.submitButton} type="submit">Save changes</button></div>
    </fieldset>
  </form>;
}
