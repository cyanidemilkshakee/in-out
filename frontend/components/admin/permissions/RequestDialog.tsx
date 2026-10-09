"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Boxes, Loader2, MapPin, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";
import type { PermissionRequest, PermissionRequestInput } from "../../../../lib/types";
import { FACILITY_ZONES, formatFacilityZones, normalizeFacilityZones } from "../../../../lib/facilityZones";
import { accessDateTimeLimits, accessWindowBounds, parseFacilityDateTime, validateAccessWindow, type DateRangeErrors } from "../../../../lib/dateTimeValidation";
import { useDateTimeNow } from "../../../hooks/useDateTimeNow";
import { FacilityZoneSelection } from "./FacilityZoneSelection";
import { facilityDateInput, facilityDateIso, permissionWindowLabels, REQUEST_LABELS } from "./requestPresentation";
import styles from "./PermissionForm.module.css";

type FormPermissionType = "visitor_access" | "new_visitor" | "zone_access" | "hardware_custody";
type BackendPermissionType = Exclude<PermissionRequest["type"], "manual_override">;

export type RequestContext = { type?: PermissionRequest["type"]; subjectId?: string };

const NEW_REQUEST_TYPES = [
  { value: "visitor_access", label: "Visitor access", icon: Users },
  { value: "new_visitor", label: "New visitor", icon: UserPlus },
  { value: "zone_access", label: REQUEST_LABELS.zone_access, icon: MapPin },
  { value: "hardware_custody", label: REQUEST_LABELS.hardware_custody, icon: Boxes },
] satisfies Array<{ value: FormPermissionType; label: string; icon: typeof Users }>;

function contextType(context: RequestContext): FormPermissionType {
  if (context.type === "visitor") return context.subjectId ? "visitor_access" : "new_visitor";
  if (context.type === "hardware_custody" || context.type === "zone_access") return context.type;
  return "zone_access";
}

function backendType(type: FormPermissionType): BackendPermissionType {
  return type === "visitor_access" || type === "new_visitor" ? "visitor" : type;
}

export function RequestDialog({ context, mode = "request", onClose, onSubmitted, onReview }: {
  context: RequestContext;
  mode?: "request" | "grant";
  onClose: () => void;
  onSubmitted: (request: PermissionRequest) => void;
  onReview: (requestId: string) => void;
}) {
  const { people, hardwareAssets, checkpoints, permissions, permissionRequests } = useDataState();
  const { submitPermissionRequest, createVisitor, grantPermission } = useDataActions();
  const isGrant = mode === "grant";
  const now = useDateTimeNow();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<FormPermissionType>(() => contextType(context));
  const [subjectId, setSubjectId] = useState(() => context.type === "visitor" && !context.subjectId ? "" : context.subjectId ?? "");
  const [checkpointId, setCheckpointId] = useState(checkpoints[0]?.id ?? "");
  const [carrierId, setCarrierId] = useState("");
  const [reason, setReason] = useState("");
  const [visitorDraft, setVisitorDraft] = useState({ name: "", barcode: "", host: "", company: "" });
  const [zones, setZones] = useState(() => normalizeFacilityZones(permissions.find((item) => item.subjectId === context.subjectId)?.zones ?? (context.type === "visitor" && mode === "grant" ? [checkpoints[0]?.zone] : [])));
  const [validFrom, setValidFrom] = useState(() => accessWindowBounds().defaultStart);
  const [validTo, setValidTo] = useState(() => facilityDateInput(new Date(parseFacilityDateTime(accessWindowBounds().defaultStart)! + 60 * 60_000)));
  const [startTouched, setStartTouched] = useState(false);
  const [endTouched, setEndTouched] = useState(false);
  const [permanentAccess, setPermanentAccess] = useState(() => mode === "grant" && contextType(context) === "zone_access");
  const [dateErrors, setDateErrors] = useState<DateRangeErrors>({});
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectablePeople = people.filter((person) => person.name.trim().toLowerCase() !== "unregistered barcode");
  const isVisitorAccess = type === "visitor_access";
  const isNewVisitor = type === "new_visitor";
  const isVisitorType = isVisitorAccess || isNewVisitor;
  const requestType = backendType(type);
  const permanentZoneAccess = isGrant && type === "zone_access" && permanentAccess;
  const subjectOptions = type === "hardware_custody"
    ? hardwareAssets
    : isVisitorAccess
      ? selectablePeople.filter((person) => person.type === "visitor")
      : [...selectablePeople, ...hardwareAssets];
  const subject = [...selectablePeople, ...hardwareAssets].find((item) => item.id === subjectId);
  const asset = hardwareAssets.find((item) => item.id === subjectId);
  const validSubject = Boolean(subject && (!isVisitorAccess || ("type" in subject && subject.type === "visitor")) && (type !== "hardware_custody" || asset));
  const employee = people.find((person) => person.id === carrierId && person.type === "employee");
  const checkpoint = checkpoints.find((item) => item.id === checkpointId);
  const currentPermission = permissions.find((item) => item.subjectId === subjectId);
  const entryRestriction = currentPermission?.entryRestriction ?? subject?.entryRestriction;
  const dateLimits = accessDateTimeLimits(validFrom, validTo, now);
  const needsZones = type === "zone_access" || isVisitorType;
  const needsDateWindow = isVisitorType || type === "zone_access";
  const needsCheckpointField = !isGrant && !isVisitorType;
  const permissionCheckpointId = isVisitorType
    ? FACILITY_ZONES.find((zone) => zone.id === normalizeFacilityZones(zones)[0])?.checkpointId ?? checkpoints[0]?.id ?? "cp-main"
    : checkpointId;
  const visitorBarcode = visitorDraft.barcode.trim();
  const visitorBarcodeValid = Boolean(visitorBarcode && visitorBarcode.length <= 64 && /^[A-Za-z0-9._:/-]+$/.test(visitorBarcode));
  const visitorRequest = permissionRequests.find((request) =>
    isVisitorAccess && request.type === "visitor" && request.subjectId === subjectId && request.status === "pending"
  );
  const invalidDateErrors = needsDateWindow
    ? validateAccessWindow(validFrom, validTo, now, permanentZoneAccess)
    : {};
  const currentZones = currentPermission?.zones ?? subject?.allowedZones ?? [];
  const subjectStart = subject && "validFrom" in subject ? subject.validFrom : undefined;
  const subjectEnd = subject && "validTo" in subject ? subject.validTo : undefined;
  const currentWindow = permissionWindowLabels(currentPermission?.validFrom ?? subjectStart, currentPermission?.validTo ?? subjectEnd);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  useEffect(() => {
    if (!checkpointId && checkpoints.length) setCheckpointId(checkpoints[0].id);
  }, [checkpointId, checkpoints]);

  useEffect(() => {
    const bounds = accessWindowBounds(now);
    const start = startTouched ? validFrom : bounds.defaultStart;
    if (!startTouched) setValidFrom(start);
    if (!endTouched && !permanentAccess) {
      const timestamp = parseFacilityDateTime(start) ?? now.getTime();
      setValidTo(facilityDateInput(new Date(Math.min(timestamp + 60 * 60_000, parseFacilityDateTime(bounds.max)!))));
    }
  }, [now, startTouched, endTouched, validFrom, permanentAccess]);

  function changeType(next: FormPermissionType) {
    setType(next);
    setError("");
    setAttemptedSubmit(false);
    setDateErrors({});
    setPermanentAccess(isGrant && next === "zone_access");
    setCarrierId("");

    if (next === "new_visitor") {
      setSubjectId("");
    } else if (next === "visitor_access") {
      const currentIsVisitor = selectablePeople.some((item) => item.id === subjectId && item.type === "visitor");
      if (!currentIsVisitor) setSubjectId(selectablePeople.find((item) => item.type === "visitor")?.id ?? "");
    } else if (next === "hardware_custody") {
      if (!hardwareAssets.some((item) => item.id === subjectId)) setSubjectId("");
    } else if (!subjectOptions.some((item) => item.id === subjectId)) {
      setSubjectId("");
    }

    if ((next === "visitor_access" || next === "new_visitor") && !zones.length) {
      setZones([FACILITY_ZONES[0].id]);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttemptedSubmit(true);
    setError("");

    const nextDateErrors = needsDateWindow ? validateAccessWindow(validFrom, validTo, new Date(), permanentZoneAccess) : {};
    setDateErrors(nextDateErrors);
    const visitorNameMissing = isNewVisitor && !visitorDraft.name.trim();
    const visitorHostMissing = isNewVisitor && !visitorDraft.host.trim();
    const visitorBarcodeMissing = isNewVisitor && !visitorBarcodeValid;
    const subjectMissing = !isNewVisitor && !validSubject;
    const carrierMissing = type === "hardware_custody" && !employee;
    const duplicateCustodian = type === "hardware_custody" && Boolean(asset?.assignedEmployeeId && asset.assignedEmployeeId === carrierId);
    const zonesMissing = needsZones && !normalizeFacilityZones(zones).length;
    const checkpointMissing = needsCheckpointField && !checkpoint;

    if (checkpointMissing) { setError("Choose a checkpoint."); return; }
    if (nextDateErrors.start || nextDateErrors.end) { setError(nextDateErrors.start ?? nextDateErrors.end ?? "Choose a valid access window."); return; }
    if (visitorNameMissing || visitorHostMissing || visitorBarcodeMissing) {
      setError(!visitorDraft.name.trim() ? "Add the visitor name." : !visitorDraft.host.trim() ? "Add the visitor host." : "Enter a valid visitor barcode using letters, numbers, dots, underscores, colons, slashes, or hyphens.");
      return;
    }
    if (subjectMissing) { setError(type === "visitor_access" ? "Choose a registered visitor." : type === "hardware_custody" ? "Choose registered hardware." : "Choose a registered subject."); return; }
    if (carrierMissing) { setError("Choose an employee to receive custody."); return; }
    if (duplicateCustodian) { setError("This employee already has custody of this asset."); return; }
    if (zonesMissing) { setError("Choose at least one zone."); return; }

    if (isNewVisitor) {
      setBusy(true);
      try {
        if (isGrant) {
          const request = await grantPermission({
            type: "visitor", subjectId: "", subjectName: visitorDraft.name.trim(), barcode: visitorBarcode,
            requester: "Administrator", purpose: reason.trim(), requestedZones: normalizeFacilityZones(zones), checkpointId: permissionCheckpointId,
            validFrom: facilityDateIso(validFrom), validTo: facilityDateIso(validTo),
            newVisitor: { name: visitorDraft.name.trim(), host: visitorDraft.host.trim(), ...(visitorDraft.company.trim() ? { company: visitorDraft.company.trim() } : {}) },
          });
          onSubmitted(request);
          return;
        }
        const result = await createVisitor({
          name: visitorDraft.name.trim(),
          barcode: visitorBarcode,
          host: visitorDraft.host.trim(),
          validFrom: facilityDateIso(validFrom),
          validTo: facilityDateIso(validTo),
          checkpointId: permissionCheckpointId,
          allowedZones: normalizeFacilityZones(zones),
          ...(reason.trim() ? { purpose: reason.trim() } : {}),
          ...(visitorDraft.company.trim() ? { company: visitorDraft.company.trim() } : {}),
        });
        onSubmitted(result.request);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : isGrant ? "Unable to grant visitor access. Please try again." : "Unable to register this visitor. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!subject || !validSubject) return;
    if (type === "hardware_custody" && !asset) { setError("Choose registered hardware."); return; }
    const requestedZones = type === "hardware_custody"
      ? []
      : normalizeFacilityZones(type === "zone_access" || isVisitorType ? zones : [checkpoint?.zone ?? ""]);
    const pending = permissionRequests.find((request) =>
      request.status === "pending" && request.type === requestType && request.subjectId === subjectId &&
      (requestType !== "hardware_custody" || request.carrierId === carrierId)
    );
    if (pending && !isGrant) { setError("A matching request is already awaiting review. Review it before submitting another."); return; }

    setBusy(true);
    try {
      const input: PermissionRequestInput = {
        type: requestType,
        subjectId,
        subjectName: subject.name,
        barcode: subject.barcode,
        requester: "Administrator",
        purpose: reason.trim(),
        requestedZones,
        checkpointId: permissionCheckpointId,
        validFrom: needsDateWindow ? facilityDateIso(validFrom) : "",
        validTo: needsDateWindow && !permanentZoneAccess ? facilityDateIso(validTo) : "",
        ...(permanentZoneAccess ? { permanentAccess: true } : {}),
        ...(type === "hardware_custody" ? { hardwareId: subjectId, carrierId, carrierName: employee!.name } : {}),
      };
      const request = isGrant ? await grantPermission(input) : await submitPermissionRequest(input);
      onSubmitted(request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isGrant ? "Unable to grant this permission. Your entries have been kept." : "Unable to submit this request. Your entries have been kept.");
    } finally {
      setBusy(false);
    }
  }

  const invalidSubject = attemptedSubmit && !isNewVisitor && !validSubject;
  const invalidCheckpoint = attemptedSubmit && needsCheckpointField && !checkpoint;
  const invalidCarrier = attemptedSubmit && type === "hardware_custody" && !employee;
  const invalidZones = attemptedSubmit && needsZones && !normalizeFacilityZones(zones).length;
  const visitorBarcodeError = attemptedSubmit && isNewVisitor && !visitorBarcodeValid;

  return <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="new-request-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit} noValidate className={styles.form}>
      <header className={styles.header}><span className={styles.headerIcon} aria-hidden="true"><ShieldCheck size={23} strokeWidth={1.7} /></span><div><h2 id="new-request-title">{isGrant ? "New permission" : "New request"}</h2><p>{isGrant ? "Grant access or reassign custody directly." : "Choose the approval you need."}</p></div><button type="button" className={styles.close} aria-label={isGrant ? "Close new permission" : "Close new request"} disabled={busy} onClick={onClose}><X size={19} /></button></header>

      <fieldset className={styles.typeSelector} disabled={busy}>
        <legend>{isGrant ? "Permission type" : "Request type"}</legend>
        <div className={styles.typeChoices}>{NEW_REQUEST_TYPES.map((item) => {
          const Icon = item.icon;
          return <label key={item.value} className={styles.typeChoice} data-selected={type === item.value}>
            <input type="radio" name="permissionType" value={item.value} checked={type === item.value} onChange={() => changeType(item.value)} />
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span>
          </label>;
        })}</div>
      </fieldset>

      <div className={styles.body}>

      {!isNewVisitor && <label className={styles.field}>
        <span>{type === "hardware_custody" ? "Asset" : isVisitorAccess ? "Visitor" : "Subject"}</span>
        <select className="admin-surface" aria-invalid={invalidSubject || undefined} value={subjectId} disabled={busy} required onChange={(event) => { setSubjectId(event.target.value); setCarrierId(""); setZones(normalizeFacilityZones(permissions.find((item) => item.subjectId === event.target.value)?.zones ?? (isGrant && isVisitorType ? [checkpoint?.zone ?? "public"] : []))); setError(""); }}>
          <option value="">Choose {type === "hardware_custody" ? "an asset" : isVisitorAccess ? "a visitor" : "a subject"}</option>
          {subjectOptions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.barcode}</option>)}
        </select>
      </label>}

      {isGrant && entryRestriction?.active && <div className={`${styles.notice} ${styles.restriction}`}><strong>Entry restriction remains active</strong><p>This grant will not restore entry. Lift the entry restriction in the access directory and add a reason after review.</p></div>}

      {isNewVisitor && <div className={styles.visitorFields}>
        <label className={styles.field}><span>Visitor name</span><input className="admin-surface" aria-invalid={attemptedSubmit && !visitorDraft.name.trim() || undefined} required maxLength={100} value={visitorDraft.name} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label className={styles.field}><span>Visitor barcode</span><input className="admin-surface" aria-invalid={visitorBarcodeError || undefined} required maxLength={64} autoCapitalize="none" spellCheck={false} value={visitorDraft.barcode} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, barcode: event.target.value }))} /></label>
        <label className={styles.field}><span>Host</span><input className="admin-surface" aria-invalid={attemptedSubmit && !visitorDraft.host.trim() || undefined} required maxLength={100} value={visitorDraft.host} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, host: event.target.value }))} /></label>
        <label className={styles.field}><span>Company</span><input className="admin-surface" maxLength={120} value={visitorDraft.company} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, company: event.target.value }))} /></label>
      </div>}

      {needsCheckpointField && <label className={styles.field}><span>Checkpoint</span><select className="admin-surface" aria-invalid={invalidCheckpoint || undefined} required disabled={busy} value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}><option value="">Choose a checkpoint</option>{checkpoints.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}

      {type === "hardware_custody" && <label className={styles.field}><span>{isGrant ? "New custodian" : "Requested custodian"}</span><select className="admin-surface" aria-invalid={invalidCarrier || undefined} required disabled={busy} value={carrierId} onChange={(event) => setCarrierId(event.target.value)}><option value="">Choose an employee</option>{people.filter((person) => person.type === "employee").map((person) => <option key={person.id} value={person.id} disabled={person.id === asset?.assignedEmployeeId}>{person.name} · {person.barcode}{person.id === asset?.assignedEmployeeId ? " · Current custodian" : ""}</option>)}</select></label>}

      {needsZones && <FacilityZoneSelection label={type === "zone_access" ? "Zone access" : "Allowed zones"} value={zones} onChange={(next) => { setZones(next); setError(""); }} disabled={busy} invalid={invalidZones} />}

      {isVisitorAccess && visitorRequest && <div className={styles.notice}><strong>Approval already pending</strong><p>{isGrant ? `Grant permission will approve ${visitorRequest.subjectName}'s pending visitor request using the dates and zones selected here.` : `${visitorRequest.subjectName} is already awaiting review.`}</p>{!isGrant && <button type="button" className={styles.reviewAction} onClick={() => onReview(visitorRequest.id)}>Review pending permission <ArrowRight size={16} /></button>}</div>}

      {needsDateWindow && <div className={styles.dates}>
        <label className={styles.field}><span>Starts</span><input className="admin-surface" name="validFrom" type="datetime-local" required {...dateLimits.start} step={60} value={validFrom} disabled={busy} aria-invalid={Boolean(attemptedSubmit && invalidDateErrors.start)} aria-describedby={dateErrors.start ? "permission-start-error" : undefined} onChange={(event) => { setStartTouched(true); setValidFrom(event.target.value); setDateErrors((current) => ({ ...current, start: undefined })); }} />{dateErrors.start && <small id="permission-start-error" className={styles.dateError}>{dateErrors.start}</small>}</label>
        <div className={`${styles.field} ${styles.endDateField}`}>
          <label htmlFor="permission-valid-to">Ends</label>
          <input className="admin-surface" id="permission-valid-to" name="validTo" type="datetime-local" required={!permanentZoneAccess} {...dateLimits.end} step={60} value={permanentZoneAccess ? "" : validTo} disabled={busy || permanentZoneAccess} aria-invalid={Boolean(attemptedSubmit && invalidDateErrors.end)} aria-describedby={dateErrors.end ? "permission-end-error" : undefined} onChange={(event) => { setEndTouched(true); setValidTo(event.target.value); setDateErrors((current) => ({ ...current, end: undefined })); }} />
          {dateErrors.end && <small id="permission-end-error" className={styles.dateError}>{dateErrors.end}</small>}
          {type === "zone_access" && isGrant && <label className={styles.permanentToggle}><input type="checkbox" checked={permanentAccess} disabled={busy} onChange={(event) => { setPermanentAccess(event.target.checked); setDateErrors((current) => ({ ...current, end: undefined })); }} /><span>Until further notice</span></label>}
        </div>
      </div>}

      {!isVisitorType && <label className={styles.field}><span>{isGrant ? "Reason (optional)" : "Purpose (optional)"}</span><textarea className="admin-surface" maxLength={1000} rows={2} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder={isGrant ? "Why are you granting this permission?" : "Why is this approval needed?"} /></label>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      {!isNewVisitor && <section className={`${styles.notice} ${styles.currentAccess}`} aria-label="Current access">
        <strong>Current access</strong>
        {!subject || !validSubject
          ? <p>Choose a person or asset to view its current access.</p>
          : <>
              {type === "hardware_custody" && <p><strong>Current custodian:</strong> {asset?.assignedEmployeeName || "Unassigned"}</p>}
              <p><strong>Zones:</strong> {formatFacilityZones(currentZones) || "No zones assigned"}</p>
              {type !== "hardware_custody" && <p className={styles.currentAccessWindow}><span>{currentWindow.start}</span><span>{currentWindow.end}</span></p>}
            </>}
      </section>}

      </div>

      <footer className={styles.footer}><button type="button" className={styles.cancelButton} disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className={styles.submitButton} disabled={busy || (type === "hardware_custody" && asset?.assignedEmployeeId === carrierId) || Boolean(!isGrant && visitorRequest)}>{busy ? <><Loader2 size={16} className={styles.spinner} />{isGrant ? "Granting…" : "Submitting…"}</> : <>{isGrant ? "Grant permission" : isNewVisitor ? "Register & request approval" : "Submit request"}<ArrowRight size={16} aria-hidden="true" /></>}</button></footer>
    </form>
  </dialog>;
}
