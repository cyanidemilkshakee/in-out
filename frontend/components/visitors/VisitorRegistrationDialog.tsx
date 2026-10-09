"use client";

import Link from "next/link";
import { Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Checkpoint, CreateVisitorInput, CreateVisitorResult, Person } from "../../../lib/types";
import { DataServiceError } from "../../../services/httpDataService";
import { facilityDateInput, facilityDateIso } from "../admin/permissions/requestPresentation";
import { accessDateTimeLimits, accessWindowBounds, validateAccessWindow } from "../../../lib/dateTimeValidation";
import { useDateTimeNow } from "../../hooks/useDateTimeNow";
import styles from "./VisitorRegistrationDialog.module.css";

const EMPTY_DRAFT = { name: "", barcode: "", host: "", company: "", purpose: "", validFrom: "", validTo: "", checkpointId: "" };
type VisitorField = keyof typeof EMPTY_DRAFT;
const BARCODE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

function newDraft(checkpoints: Checkpoint[]) {
  return {
    ...EMPTY_DRAFT,
    validFrom: accessWindowBounds().defaultStart,
    validTo: facilityDateInput(new Date(Date.now() + 4 * 60 * 60_000)),
    checkpointId: checkpoints[0]?.id ?? "",
  };
}

export function VisitorRegistrationNotice({ visitor, canManagePermissions = false }: { visitor: Person; canManagePermissions?: boolean }) {
  return (
    <div className={styles.notice} role="status">
      <strong>{visitor.name} is registered. Approval is pending.</strong>
      <span>The request has been sent to Permission Manager. Access is not active yet.</span>
      {canManagePermissions && <Link href={`/admin/permissions?subject=${encodeURIComponent(visitor.id)}`}>View approval request</Link>}
    </div>
  );
}

export function VisitorRegistrationDialog({ open, onClose, onCreate, onCreated, checkpoints, online = true }: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateVisitorInput) => Promise<CreateVisitorResult>;
  onCreated: (visitor: Person) => void;
  checkpoints: Checkpoint[];
  online?: boolean;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const datesEditedRef = useRef({ start: false, end: false });
  const [draft, setDraft] = useState(() => newDraft(checkpoints));
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<VisitorField, string>>>({});
  const [error, setError] = useState("");
  const [networkOnline, setNetworkOnline] = useState(true);
  const now = useDateTimeNow(open);
  const dateLimits = accessDateTimeLimits(draft.validFrom, draft.validTo, now);

  useEffect(() => {
    if (!open || (datesEditedRef.current.start && datesEditedRef.current.end)) return;
    const fresh = newDraft(checkpoints);
    setDraft((current) => ({ ...current, validFrom: datesEditedRef.current.start ? current.validFrom : fresh.validFrom, validTo: datesEditedRef.current.end ? current.validTo : fresh.validTo }));
  }, [open, now, checkpoints]);

  useEffect(() => {
    const update = () => setNetworkOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setError("");
      setFieldErrors({});
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (checkpoints.length && !draft.checkpointId) {
      setDraft((current) => ({ ...current, checkpointId: checkpoints[0].id }));
    }
  }, [checkpoints, draft.checkpointId]);

  const connected = online && networkOnline;

  function change(field: VisitorField, value: string) {
    if (field === "validFrom") datesEditedRef.current.start = true;
    if (field === "validTo") datesEditedRef.current.end = true;
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setError("");
  }

  function close() {
    if (!submittingRef.current) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    if (!connected) { setError("Connect to the network before registering a visitor."); return; }
    const name = draft.name.trim();
    const barcode = draft.barcode.trim();
    const host = draft.host.trim();
    const errors: Partial<Record<VisitorField, string>> = {};
    if (!name) errors.name = "Visitor name is required.";
    if (!barcode) errors.barcode = "Visitor barcode is required.";
    else if (barcode.length > 64 || !BARCODE_PATTERN.test(barcode)) errors.barcode = "Use up to 64 letters, numbers, dots, underscores, colons, slashes, or hyphens.";
    if (!host) errors.host = "Host is required.";
    if (!draft.checkpointId) errors.checkpointId = "Choose a checkpoint.";
    const windowErrors = validateAccessWindow(draft.validFrom, draft.validTo);
    if (windowErrors.start) errors.validFrom = windowErrors.start;
    if (windowErrors.end) errors.validTo = windowErrors.end;
    setFieldErrors(errors);
    setError("");
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      dialogRef.current?.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    const input: CreateVisitorInput = {
      name, barcode, host,
      validFrom: facilityDateIso(draft.validFrom),
      validTo: facilityDateIso(draft.validTo),
      checkpointId: draft.checkpointId,
      ...(draft.company.trim() ? { company: draft.company.trim() } : {}),
      ...(draft.purpose.trim() ? { purpose: draft.purpose.trim() } : {}),
    };
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await onCreate(input);
      onCreated(result.visitor);
      datesEditedRef.current = { start: false, end: false };
      setDraft(newDraft(checkpoints));
      onClose();
    } catch (cause) {
      if (cause instanceof DataServiceError && cause.status === 409) {
        setFieldErrors({ barcode: "This barcode is already registered. Use a different barcode." });
        dialogRef.current?.querySelector<HTMLInputElement>('[name="barcode"]')?.focus();
      } else {
        setError(cause instanceof Error ? cause.message : "Unable to register this visitor. Please try again.");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const fieldProps = (field: VisitorField) => ({
    id: `${id}-${field}`,
    name: field,
    value: draft[field],
    disabled: submitting,
    "aria-invalid": Boolean(fieldErrors[field]),
    "aria-describedby": fieldErrors[field] ? `${id}-${field}-error` : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(field, event.target.value),
  });
  const fieldError = (field: VisitorField) => fieldErrors[field]
    ? <span id={`${id}-${field}-error`} className={styles.fieldError}>{fieldErrors[field]}</span>
    : null;

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={(event) => { event.preventDefault(); close(); }} onClose={close}>
      <form className={styles.form} onSubmit={submit} noValidate aria-busy={submitting}>
        <header className={styles.header}>
          <div><h2 id={`${id}-title`}>Register a visitor</h2><p id={`${id}-description`}>Registration sends an approval request. Visitors can enter only after an administrator approves access.</p></div>
          <button className={styles.closeButton} type="button" disabled={submitting} aria-label="Close visitor registration" onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className={styles.fields}>
          <label className={`${styles.field} ${styles.wide}`} htmlFor={`${id}-name`}><span>Visitor name <em>Required</em></span><input {...fieldProps("name")} autoFocus required maxLength={100} autoComplete="name" />{fieldError("name")}</label>
          <label className={styles.field} htmlFor={`${id}-barcode`}><span>Visitor barcode <em>Required</em></span><input {...fieldProps("barcode")} required maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} />{fieldError("barcode")}</label>
          <label className={styles.field} htmlFor={`${id}-host`}><span>Host <em>Required</em></span><input {...fieldProps("host")} required maxLength={100} />{fieldError("host")}</label>
          <label className={styles.field} htmlFor={`${id}-company`}><span>Company</span><input {...fieldProps("company")} maxLength={120} autoComplete="organization" /></label>
          <label className={styles.field} htmlFor={`${id}-checkpointId`}><span>Checkpoint <em>Required</em></span><select {...fieldProps("checkpointId")} required><option value="">Choose a checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.name}</option>)}</select>{fieldError("checkpointId")}</label>
          <label className={styles.field} htmlFor={`${id}-validFrom`}><span>Valid from <em>Required</em></span><input {...fieldProps("validFrom")} type="datetime-local" required step={60} {...dateLimits.start} />{fieldError("validFrom")}</label>
          <label className={styles.field} htmlFor={`${id}-validTo`}><span>Valid to <em>Required</em></span><input {...fieldProps("validTo")} type="datetime-local" required step={60} {...dateLimits.end} />{fieldError("validTo")}</label>
          <small className={styles.timezone}>Facility time: Asia/Kolkata (UTC+05:30). Choose a window within the next 6 calendar months.</small>
          <label className={`${styles.field} ${styles.wide}`} htmlFor={`${id}-purpose`}><span>Purpose</span><textarea {...fieldProps("purpose")} maxLength={240} rows={3} /></label>
        </div>
        {!connected && <p className={styles.error} role="status">Visitor registration needs a network connection. Your entered details are kept.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <footer className={styles.actions}>
          <button className={styles.cancelButton} type="button" disabled={submitting} onClick={close}>Cancel</button>
          <button className={styles.submitButton} type="submit" disabled={submitting || !connected}>{submitting ? <><Loader2 className={styles.spin} aria-hidden="true" />Registering…</> : "Register & request approval"}</button>
        </footer>
      </form>
    </dialog>
  );
}
