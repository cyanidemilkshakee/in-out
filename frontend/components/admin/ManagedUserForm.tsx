"use client";

import { type FormEventHandler } from "react";
import { Check, ScanLine, ShieldCheck } from "lucide-react";
import type { Checkpoint } from "../../../lib/types";
import type { OrganizationZone } from "../../../lib/types";
import { checkpointDisplayName } from "../../../lib/facilityZones";
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

function AccessFields({ form, onChange, checkpoints, zones, showEnabled = true, operatorOnly = false, invitation = false }: Pick<FormProps, "form" | "onChange" | "checkpoints" | "zones"> & { showEnabled?: boolean; operatorOnly?: boolean; invitation?: boolean }) {
  const operator = form.roles.includes("operator");
  const zoneAdmin = form.roles.includes("zone-admin");
  const roles = [
    { value: "zone-admin", title: "Zone admin", icon: ShieldCheck },
    { value: "operator", title: "Operator", icon: ScanLine },
  ] as const;

  if (operatorOnly) return <section className={styles.section} aria-label="Operator access">
    <div className={styles.operatorRole}><strong>Role</strong><span>Operator</span></div>
    {showEnabled ? <label className={styles.toggle}><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /><strong>Allow sign-in</strong></label> : null}
    <label className={`${styles.field} ${styles.checkpointField}`}><span>Assigned checkpoint</span><select required value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="" disabled>Select checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === (checkpoint.zoneId ?? checkpoint.zone))?.name ?? `Zone ${(checkpoint.zoneId ?? checkpoint.zone).toUpperCase()}`} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select></label>
  </section>;

  if (invitation) return <section className={styles.section} aria-label="Invitation access">
    <label className={styles.field}><span>Role</span><select required value={form.roles[0] ?? ""} onChange={(event) => {
      const role = event.target.value as "zone-admin" | "operator" | "";
      onChange({ ...form, roles: role ? [role] : [], checkpointId: role === "operator" ? form.checkpointId : null, zoneIds: role === "zone-admin" ? form.zoneIds : [] });
    }}><option value="" disabled>Select role</option><option value="operator">Operator</option><option value="zone-admin">Zone admin</option></select></label>
    {operator ? <label className={`${styles.field} ${styles.checkpointField}`}><span>Assigned checkpoint</span><select required value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null, zoneIds: [] })}><option value="" disabled>Select checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === checkpoint.zoneId)?.name ?? `Zone ${checkpoint.zone.toUpperCase()}`} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select></label> : null}
    {zoneAdmin ? <fieldset className={styles.zoneFieldset}>
      <legend>Assigned zones</legend>
      <div className={styles.zoneOptions}>{zones.map((zone, index) => <label key={zone.id} className={styles.zoneOption}>
        <input type="checkbox" required={index === 0 && form.zoneIds.length === 0}
          checked={form.zoneIds.includes(zone.id)}
          onChange={(event) => onChange({ ...form, checkpointId: null, zoneIds: event.target.checked
            ? [...form.zoneIds, zone.id] : form.zoneIds.filter((id) => id !== zone.id) })} />
        <span>{zone.name}</span>
      </label>)}</div>
    </fieldset> : null}
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
        <label className={`${styles.field} ${styles.checkpointField}`}><span>Checkpoint</span><select required={operator} value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="">Unassigned</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === (checkpoint.zoneId ?? checkpoint.zone))?.name ?? `Zone ${(checkpoint.zoneId ?? checkpoint.zone).toUpperCase()}`} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select></label>
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
  return <form className={styles.form} aria-busy={busy} onSubmit={onSubmit}>
    <fieldset className={styles.fields} disabled={busy}>
      <div className={styles.creationGrid}>
        {restrictedToOperator ? <p className={styles.scopeHint}>{zones.length
          ? `Invites an operator for your assigned zones (${zones.map((zone) => zone.name).join(", ")}). They can sign in with Zoho and scan only at the selected checkpoint.`
          : "No zones are assigned to your account, so there are no checkpoints available. Ask a master admin to assign a zone first."}</p> : null}
        <IdentityFields form={form} onChange={onChange} creating={false} requireProfile />
        <AccessFields form={form} onChange={onChange} checkpoints={checkpoints} zones={zones} operatorOnly={restrictedToOperator} showEnabled={false} invitation />
        <p className={styles.scopeHint}>An email invitation will be sent. The account stays disabled until the recipient accepts and signs in with Zoho.</p>
      </div>
      <div className={styles.footer}><button className={styles.cancelButton} type="button" onClick={onCancel}>Cancel</button><button className={styles.submitButton} type="submit">{submitLabel ?? "Send invitation"}</button></div>
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
          <label className={`${styles.field} ${styles.checkpointField}`}><span>Assigned checkpoint</span><select required value={form.checkpointId ?? ""} onChange={(event) => onChange({ ...form, checkpointId: event.target.value || null })}><option value="" disabled>Select checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === (checkpoint.zoneId ?? checkpoint.zone))?.name ?? `Zone ${(checkpoint.zoneId ?? checkpoint.zone).toUpperCase()}`} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select></label>
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
