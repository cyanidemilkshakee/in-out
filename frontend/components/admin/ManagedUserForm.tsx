"use client";

import { useId, useState, type FormEventHandler } from "react";
import { Check, Eye, EyeOff, ScanLine, ShieldCheck } from "lucide-react";
import type { Checkpoint } from "../../../lib/types";
import type { OrganizationZone } from "../../../lib/types";
import type { ManagedUser } from "../../../services/keycloakUserService";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../../../lib/passwordLimits";
import styles from "./ManagedUserForm.module.css";

export type ManagedUserFormValue = {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  temporaryPassword: boolean;
  enabled: boolean;
  roles: Array<"zone-admin" | "operator">;
  checkpointId: ManagedUser["checkpointId"];
  zoneIds: string[];
};

type FormProps = {
  form: ManagedUserFormValue;
  onChange: (form: ManagedUserFormValue) => void;
  busy: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  checkpoints: Checkpoint[];
  zones: OrganizationZone[];
};

function checkpointGateSuffix(checkpoint: Checkpoint) {
  const label = checkpoint.gateLabel?.trim();
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return label && normalize(label) !== normalize(checkpoint.name) ? ` — ${label}` : "";
}

function IdentityFields({ form, onChange, creating, requireProfile = false }: Pick<FormProps, "form" | "onChange"> & { creating: boolean; requireProfile?: boolean }) {
  return (
    <section className={styles.section} aria-label="Profile details">
      <div className={styles.twoColumn}>
        <label className={styles.field}><span>First name</span><input required={requireProfile} maxLength={100} autoComplete="given-name" value={form.firstName} onChange={(event) => onChange({ ...form, firstName: event.target.value })} /></label>
        <label className={styles.field}><span>Last name</span><input required={requireProfile} maxLength={100} autoComplete="family-name" value={form.lastName} onChange={(event) => onChange({ ...form, lastName: event.target.value })} /></label>
      </div>
      {creating ? <label className={styles.field}><span>Username</span><input required minLength={3} maxLength={64} pattern={"[A-Za-z0-9._\\-]+"} autoComplete="username" autoCapitalize="none" spellCheck={false} value={form.username} onChange={(event) => onChange({ ...form, username: event.target.value })} /></label> : null}
      <label className={styles.field}><span>Email</span><input required={requireProfile} type="email" maxLength={320} autoComplete="email" value={form.email} onChange={(event) => onChange({ ...form, email: event.target.value })} /></label>
    </section>
  );
}

function AccessFields({ form, onChange, checkpoints, zones, showEnabled = true, operatorOnly = false }: Pick<FormProps, "form" | "onChange" | "checkpoints" | "zones"> & { showEnabled?: boolean; operatorOnly?: boolean }) {
  const operator = form.roles.includes("operator");
  const zoneAdmin = form.roles.includes("zone-admin");
  const roles = [
    { value: "zone-admin", title: "Zone admin", icon: ShieldCheck },
    { value: "operator", title: "Operator", icon: ScanLine },
  ] as const;

  if (operatorOnly) return <section className={styles.section} aria-label="Operator access">
    <div className={styles.operatorRole}><strong>Role</strong><span>Operator</span></div>
    {showEnabled ? <label className={styles.toggle}><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /><strong>Allow sign-in</strong></label> : null}
    <label className={`${styles.field} ${styles.checkpointField}`}><span>Assigned checkpoint</span><select required value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="" disabled>Select checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === checkpoint.zoneId)?.name ?? `Zone ${checkpoint.zone.toUpperCase()}`} · {checkpoint.name}{checkpointGateSuffix(checkpoint)}</option>)}</select></label>
  </section>;

  return (
    <section className={styles.section} aria-label="Access settings">
      <div className={`${styles.accessFieldsRow} ${showEnabled ? styles.accessFieldsStack : ""}`}>
        <fieldset className={styles.roleFieldset}>
          <legend className={styles.visuallyHidden}>Roles</legend>
          <div className={styles.roleHeader}>
            <span aria-hidden="true">Roles</span>
            {showEnabled ? <label className={`${styles.toggle} ${styles.topToggle}`}><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /><strong>Enabled</strong></label> : null}
          </div>
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
        <label className={`${styles.field} ${styles.checkpointField}`}><span>Checkpoint</span><select required={operator} value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="">Unassigned</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === checkpoint.zoneId)?.name ?? `Zone ${checkpoint.zone.toUpperCase()}`} · {checkpoint.name}{checkpointGateSuffix(checkpoint)}</option>)}</select></label>
      </div>
      {zoneAdmin ? <fieldset className={styles.zoneFieldset}>
        <legend>Assigned zones</legend>
        <div className={styles.zoneOptions}>{zones.map((zone, index) => <label key={zone.id} className={styles.zoneOption}>
          <input type="checkbox" required={index === 0 && form.zoneIds.length === 0}
            checked={form.zoneIds.includes(zone.id)}
            onChange={(event) => onChange({ ...form, zoneIds: event.target.checked
              ? [...form.zoneIds, zone.id] : form.zoneIds.filter((id) => id !== zone.id) })} />
          <span>{zone.name}</span>
        </label>)}</div>
      </fieldset> : null}
    </section>
  );
}

export function CreateUserForm({ form, onChange, busy, onSubmit, onCancel, checkpoints, zones, restrictedToOperator = false, submitLabel }: FormProps & { onCancel: () => void; restrictedToOperator?: boolean; submitLabel?: string }) {
  const id = useId();
  const [showPassword, setShowPassword] = useState(false);

  return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
    <fieldset className={styles.fields} disabled={busy}>
      <div className={styles.creationGrid}>
        {restrictedToOperator ? <p className={styles.scopeHint}>{zones.length
          ? `Creates an In/Out operator sign-in account for your assigned zones (${zones.map((zone) => zone.name).join(", ")}). The operator can scan only at the selected checkpoint.`
          : "No zones are assigned to your account, so there are no checkpoints available. Ask a master admin to assign a zone first."}</p> : null}
        <IdentityFields form={form} onChange={onChange} creating requireProfile={restrictedToOperator} />
        <AccessFields form={form} onChange={onChange} checkpoints={checkpoints} zones={zones} operatorOnly={restrictedToOperator} />
        <section className={`${styles.section} ${styles.passwordSection}`} aria-label="Password settings">
          <label className={styles.field} htmlFor={`${id}-new-password`}><span>Password</span></label>
          <div className={styles.passwordInput}><input id={`${id}-new-password`} required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} type={showPassword ? "text" : "password"} autoComplete="new-password" value={form.password} onChange={(event) => onChange({ ...form, password: event.target.value })} placeholder="At least 12 characters" /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</button></div>
          <label className={styles.toggle}><input type="checkbox" checked={form.temporaryPassword} onChange={(event) => onChange({ ...form, temporaryPassword: event.target.checked })} /><strong>Change at sign-in</strong></label>
        </section>
      </div>
      <div className={styles.footer}><button className={styles.cancelButton} type="button" onClick={onCancel}>Cancel</button><button className={styles.submitButton} type="submit">{submitLabel ?? (restrictedToOperator ? "Create operator account" : "Create user")}</button></div>
    </fieldset>
  </form>;
}

export function UserDetailsForm({ form, onChange, busy, onSubmit, accessOnly = false, checkpoints, zones }: FormProps & { accessOnly?: boolean }) {
  if (accessOnly) {
    return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
      <fieldset className={styles.fields} disabled={busy}>
        <section className={styles.section} aria-label="Operator access">
          <p className={styles.scopeHint}>Change whether this operator can sign in and which scanner checkpoint they can use. Save to apply. Ask a master admin to change profile details, roles, zone assignments, or an existing password.</p>
          <label className={styles.toggle}><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /><strong>Allow sign-in</strong></label>
          <label className={`${styles.field} ${styles.checkpointField}`}><span>Assigned checkpoint</span><select required value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="" disabled>Select checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === checkpoint.zoneId)?.name ?? `Zone ${checkpoint.zone.toUpperCase()}`} · {checkpoint.name}{checkpointGateSuffix(checkpoint)}</option>)}</select></label>
        </section>
        <div className={styles.footer}><button className={styles.submitButton} type="submit">Save operator access</button></div>
      </fieldset>
    </form>;
  }
  return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
    <fieldset className={styles.fields} disabled={busy}>
      <IdentityFields form={form} onChange={onChange} creating={false} />
      <AccessFields form={form} onChange={onChange} checkpoints={checkpoints} zones={zones} showEnabled={false} />
      <div className={styles.footer}><button className={styles.submitButton} type="submit">Save changes</button></div>
    </fieldset>
  </form>;
}
