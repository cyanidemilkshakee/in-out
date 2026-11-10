"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { Package, UserRound, UsersRound } from "lucide-react";
import type { Checkpoint, CreateEmployeeInput, CreateHardwareAssetInput, CreateVisitorInput, Person, ZoneAccessRequestTarget } from "../../../../lib/types";
import { checkpointDisplayName, facilityZoneLabel } from "../../../../lib/facilityZones";
import { accessWindowBounds, parseFacilityDateTime } from "../../../../lib/dateTimeValidation";
import { facilityDateInput } from "../permissions/requestPresentation";
import { CreationDialog } from "./CreationDialog";
import { RegistryEmployeePicker } from "./RegistryEmployeePicker";
import { useOrganizationZones } from "../../../hooks/useOrganizationZones";
import { listZoneAccessRequestTargets } from "../../../../services/zoneService";
import styles from "../permissions/PermissionForm.module.css";

export type RegistryCreateKind = "employee" | "visitor" | "hardware";

const initialEmployee: CreateEmployeeInput = {
  name: "",
  barcode: "",
  status: "active",
  allowedZones: [],
  allowedCheckpoints: [],
};

const initialHardware: CreateHardwareAssetInput = {
  name: "",
  barcode: "",
  ownerId: "",
  category: "",
  allowedZone: "",
  status: "active",
};

function initialVisitor(checkpointId = ""): CreateVisitorInput {
  return {
    name: "",
    barcode: "",
    host: "",
    validFrom: "",
    validTo: "",
    checkpointId,
    allowedZones: [],
    company: "",
    purpose: "",
  };
}

function visitorDefaults(checkpoints: Checkpoint[], zoneId?: string) {
  const bounds = accessWindowBounds();
  const start = bounds.defaultStart;
  const startTimestamp = parseFacilityDateTime(start) ?? Date.now();
  const available = checkpoints.filter((checkpoint) => checkpoint.active !== false);
  const checkpoint = available.find((item) => item.zoneId === zoneId && (item.required || item.number === 1))
    ?? available.find((item) => item.zoneId === zoneId)
    ?? available.find((item) => item.required || item.number === 1)
    ?? available[0];
  return {
    ...initialVisitor(checkpoint?.id ?? ""),
    allowedZones: checkpoint ? [checkpoint.zoneId ?? checkpoint.zone] : [],
    validFrom: start,
    validTo: facilityDateInput(new Date(startTimestamp + 60 * 60_000)),
  };
}

export function RegistryCreateDialog({
  initialKind,
  employees,
  checkpoints,
  onCreateEmployee,
  onCreateVisitor,
  onCreateHardware,
  searchEmployees = false,
}: {
  initialKind: RegistryCreateKind;
  employees: Person[];
  checkpoints: Checkpoint[];
  onCreateEmployee: (input: CreateEmployeeInput) => Promise<unknown>;
  onCreateVisitor: (input: CreateVisitorInput) => Promise<unknown>;
  onCreateHardware: (input: CreateHardwareAssetInput) => Promise<unknown>;
  searchEmployees?: boolean;
}) {
  const [kind, setKind] = useState<RegistryCreateKind>(initialKind);
  const [employeeForm, setEmployeeForm] = useState(initialEmployee);
  const [visitorForm, setVisitorForm] = useState(() => initialVisitor());
  const [hardwareForm, setHardwareForm] = useState(initialHardware);
  const { zones, loaded: zonesLoaded } = useOrganizationZones();
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [employeeTab, setEmployeeTab] = useState<"checkpoints" | "request-zone">("checkpoints");
  const [checkpointsTouched, setCheckpointsTouched] = useState(false);
  const [requestTargets, setRequestTargets] = useState<ZoneAccessRequestTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [targetZoneId, setTargetZoneId] = useState("");
  const [zoneRequestReason, setZoneRequestReason] = useState("");

  useEffect(() => {
    if (!dialogOpen) return;
    const activeCheckpointIds = checkpoints.filter((checkpoint) => checkpoint.active !== false).map((checkpoint) => checkpoint.id);
    setEmployeeForm((current) => ({
      ...current,
      allowedCheckpoints: checkpointsTouched
        ? (current.allowedCheckpoints ?? []).filter((id) => activeCheckpointIds.includes(id))
        : activeCheckpointIds,
    }));
  }, [checkpoints, checkpointsTouched, dialogOpen]);

  useEffect(() => {
    if (!dialogOpen || kind !== "employee" || employeeTab !== "request-zone" || targetsLoaded) return;
    const controller = new AbortController();
    setTargetsLoading(true);
    void listZoneAccessRequestTargets(controller.signal).then((targets) => {
      setRequestTargets(targets);
      setTargetZoneId((current) => targets.some((target) => target.id === current) ? current : "");
      setTargetsLoaded(true);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load zones for access requests.");
    }).finally(() => {
      if (!controller.signal.aborted) setTargetsLoading(false);
    });
    return () => controller.abort();
  }, [dialogOpen, employeeTab, kind, targetsLoaded]);

  useEffect(() => {
    if (!dialogOpen || !zonesLoaded || !zones.length) return;
    setHardwareForm((current) => current.allowedZone
      ? current
      : { ...current, allowedZone: zones[0].id });
    setVisitorForm((current) => current.checkpointId
      ? current
      : visitorDefaults(checkpoints, zones[0].id));
  }, [checkpoints, dialogOpen, zones, zonesLoaded]);

  const title = kind === "employee" ? "Create Employee" : kind === "visitor" ? "Create Visitor" : "Create Hardware";
  const submitLabel = title;
  const activeEmployeeCheckpoints = checkpoints.filter((checkpoint) => checkpoint.active !== false);
  const selectedEmployeeZoneIds = new Set(activeEmployeeCheckpoints
    .filter((checkpoint) => (employeeForm.allowedCheckpoints ?? []).includes(checkpoint.id))
    .map((checkpoint) => checkpoint.zoneId ?? checkpoint.zone));
  const availableRequestTargets = requestTargets.filter((target) => !selectedEmployeeZoneIds.has(target.id));

  useEffect(() => {
    if (targetZoneId && !availableRequestTargets.some((target) => target.id === targetZoneId)) setTargetZoneId("");
  }, [availableRequestTargets, targetZoneId]);

  function open() {
    setKind(initialKind);
    setEmployeeForm({ ...initialEmployee, allowedCheckpoints: checkpoints.filter((item) => item.active !== false).map((item) => item.id) });
    setVisitorForm(visitorDefaults(checkpoints, zones[0]?.id));
    setHardwareForm({ ...initialHardware, allowedZone: zones[0]?.id ?? "" });
    setEmployeeTab("checkpoints");
    setCheckpointsTouched(false);
    setRequestTargets([]);
    setTargetsLoaded(false);
    setTargetsLoading(false);
    setTargetZoneId("");
    setZoneRequestReason("");
    setError("");
  }

  async function submit() {
    try {
      if (kind === "employee") {
        const selectedCheckpoints = (employeeForm.allowedCheckpoints ?? []).filter((id) => activeEmployeeCheckpoints.some((checkpoint) => checkpoint.id === id));
        if (!selectedCheckpoints.length) {
          setError("Choose at least one allowed checkpoint.");
          return false;
        }
        const allowedZones = [...new Set(activeEmployeeCheckpoints.filter((checkpoint) => selectedCheckpoints.includes(checkpoint.id)).map((checkpoint) => checkpoint.zoneId ?? checkpoint.zone))];
        const input: CreateEmployeeInput = { ...employeeForm, allowedCheckpoints: selectedCheckpoints, allowedZones };
        if (employeeTab === "request-zone") {
          const reason = zoneRequestReason.trim();
          if (employeeForm.status !== "active") {
            setError("Set the employee to active before requesting access to another zone.");
            return false;
          }
          if (!targetZoneId || !availableRequestTargets.some((target) => target.id === targetZoneId)) {
            setError("Choose a zone with an assigned zone admin.");
            return false;
          }
          if (!reason) {
            setError("Enter a reason for requesting access to another zone.");
            return false;
          }
          input.zoneAccessRequest = { zoneId: targetZoneId, reason };
        }
        await onCreateEmployee(input);
      }
      else if (kind === "visitor") await onCreateVisitor(visitorForm);
      else await onCreateHardware(hardwareForm);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to create the ${kind}.`);
      return false;
    }
  }

  function changeKind(next: RegistryCreateKind) {
    setKind(next);
    setError("");
    if (next === "visitor" && !visitorForm.checkpointId) setVisitorForm(visitorDefaults(checkpoints, zones[0]?.id));
  }

  function handleEmployeeTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === "Home" ? "checkpoints"
      : event.key === "End" ? "request-zone"
      : employeeTab === "checkpoints" ? "request-zone" : "checkpoints";
    setEmployeeTab(nextTab);
    document.getElementById(nextTab === "checkpoints" ? "employee-checkpoints-tab" : "employee-zone-request-tab")?.focus();
  }

  return (
    <CreationDialog
      triggerLabel="Create"
      title={title}
      description="Create a registry record and its access profile."
      submitLabel={submitLabel}
      error={error}
      onOpen={open}
      onSubmit={submit}
      onOpenChange={setDialogOpen}
    >
      <fieldset className={styles.typeSelector}>
        <legend>Record type</legend>
        <div className={styles.typeChoices}>
          {([
            ["employee", "Employee", UserRound],
            ["visitor", "Visitor", UsersRound],
            ["hardware", "Hardware", Package],
          ] as const).map(([value, label, Icon]) => (
            <label key={value} className={styles.typeChoice} data-selected={kind === value}>
              <input type="radio" name="registryRecordType" value={value} checked={kind === value} onChange={() => changeKind(value)} />
              <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "employee" && <div className={styles.creationFields}>
        <label className={styles.field}><span>Name</span><input value={employeeForm.name} onChange={(event) => { setEmployeeForm((current) => ({ ...current, name: event.target.value })); setError(""); }} placeholder="Employee name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={employeeForm.barcode} onChange={(event) => { setEmployeeForm((current) => ({ ...current, barcode: event.target.value })); setError(""); }} placeholder="Employee barcode" required /></label>
        <label className={styles.field}><span>Status</span><select value={employeeForm.status} onChange={(event) => setEmployeeForm((current) => ({ ...current, status: event.target.value as CreateEmployeeInput["status"] }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <div className={styles.creationFieldSpan}>
          <div className={styles.employeeAccessTabs} role="tablist" aria-label="Employee access options" onKeyDown={handleEmployeeTabsKeyDown}>
            <button id="employee-checkpoints-tab" type="button" role="tab" tabIndex={employeeTab === "checkpoints" ? 0 : -1} aria-selected={employeeTab === "checkpoints"} aria-controls="employee-checkpoints-panel" className={styles.employeeAccessTab} data-selected={employeeTab === "checkpoints"} onClick={() => { setEmployeeTab("checkpoints"); setError(""); }}>Allowed checkpoints</button>
            <button id="employee-zone-request-tab" type="button" role="tab" tabIndex={employeeTab === "request-zone" ? 0 : -1} aria-selected={employeeTab === "request-zone"} aria-controls="employee-zone-request-panel" className={styles.employeeAccessTab} data-selected={employeeTab === "request-zone"} onClick={() => { setEmployeeTab("request-zone"); setError(""); }}>Request zone access</button>
          </div>
          <section id="employee-checkpoints-panel" role="tabpanel" aria-labelledby="employee-checkpoints-tab" hidden={employeeTab !== "checkpoints"} className={styles.checkpointChoices}>
              <p className={styles.accessTabHint}>Choose the checkpoints this employee can use. New active checkpoints appear here automatically.</p>
              {checkpoints.filter((checkpoint) => checkpoint.active !== false).map((checkpoint) => {
                const id = checkpoint.id;
                const selected = (employeeForm.allowedCheckpoints ?? []).includes(id);
                const zoneId = checkpoint.zoneId ?? checkpoint.zone;
                const checkpointName = checkpointDisplayName(checkpoint, zones);
                return <label key={id} className={styles.checkpointChoice}>
                  <input type="checkbox" checked={selected} onChange={(event) => {
                    setCheckpointsTouched(true);
                    if (event.target.checked && targetZoneId === zoneId) setTargetZoneId("");
                    setEmployeeForm((current) => ({ ...current, allowedCheckpoints: event.target.checked
                      ? [...new Set([...(current.allowedCheckpoints ?? []), id])]
                      : (current.allowedCheckpoints ?? []).filter((value) => value !== id) }));
                    setError("");
                  }} />
                  <span><strong>{checkpointName}</strong><small>{facilityZoneLabel(zoneId, zones)}</small></span>
                </label>;
              })}
              {!checkpoints.some((checkpoint) => checkpoint.active !== false) && <p className={styles.accessTabHint}>No active checkpoints are available in your zone.</p>}
          </section>
          <section id="employee-zone-request-panel" role="tabpanel" aria-labelledby="employee-zone-request-tab" hidden={employeeTab !== "request-zone"} className={styles.zoneRequestFields}>
              <p className={styles.accessTabHint}>The employee will be created with the selected checkpoints above. The other zone’s admin will review this request in Permission Manager.</p>
              <label className={styles.field}><span>Zone</span><select value={targetZoneId} disabled={targetsLoading || !targetsLoaded || !availableRequestTargets.length || employeeForm.status !== "active"} onChange={(event) => { setTargetZoneId(event.target.value); setError(""); }} required={employeeTab === "request-zone"}><option value="">{targetsLoading ? "Loading zones…" : "Choose a zone"}</option>{availableRequestTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
              <label className={styles.field}><span>Reason</span><textarea value={zoneRequestReason} onChange={(event) => { setZoneRequestReason(event.target.value); setError(""); }} placeholder="Why does this employee need access to this zone?" maxLength={1000} rows={3} required={employeeTab === "request-zone"} /></label>
              {employeeForm.status !== "active" && <p className={styles.accessTabHint}>Activate the employee to request access to another zone.</p>}
              {targetsLoaded && !availableRequestTargets.length && <p className={styles.accessTabHint}>No other active zone with an assigned zone admin is available beyond the checkpoints selected above.</p>}
          </section>
        </div>
      </div>}

      {kind === "visitor" && <div className={styles.creationFields}>
        <label className={styles.field}><span>Name</span><input value={visitorForm.name} onChange={(event) => setVisitorForm((current) => ({ ...current, name: event.target.value }))} placeholder="Visitor name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={visitorForm.barcode} autoCapitalize="none" spellCheck={false} onChange={(event) => setVisitorForm((current) => ({ ...current, barcode: event.target.value }))} placeholder="Visitor barcode" required /></label>
        <label className={styles.field}><span>Host</span><input value={visitorForm.host} onChange={(event) => setVisitorForm((current) => ({ ...current, host: event.target.value }))} placeholder="Host employee" required /></label>
        <label className={styles.field}><span>Company</span><input value={visitorForm.company ?? ""} onChange={(event) => setVisitorForm((current) => ({ ...current, company: event.target.value }))} placeholder="Company (optional)" /></label>
        <label className={styles.field}><span>Valid from</span><input type="datetime-local" value={visitorForm.validFrom} onChange={(event) => setVisitorForm((current) => ({ ...current, validFrom: event.target.value }))} required /></label>
        <label className={styles.field}><span>Valid to</span><input type="datetime-local" value={visitorForm.validTo} onChange={(event) => setVisitorForm((current) => ({ ...current, validTo: event.target.value }))} required /></label>
        <label className={styles.field}><span>Checkpoint</span><select value={visitorForm.checkpointId} onChange={(event) => {
          const checkpoint = checkpoints.find((item) => item.id === event.target.value);
          setVisitorForm((current) => ({ ...current, checkpointId: event.target.value, allowedZones: checkpoint ? [checkpoint.zoneId ?? checkpoint.zone] : [] }));
        }} required><option value="">Choose a checkpoint</option>{checkpoints.filter((item) => item.active !== false).map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{facilityZoneLabel(checkpoint.zoneId ?? checkpoint.zone, zones)} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select></label>
        <label className={`${styles.field} ${styles.creationFieldSpan}`}><span>Purpose</span><textarea value={visitorForm.purpose ?? ""} onChange={(event) => setVisitorForm((current) => ({ ...current, purpose: event.target.value }))} placeholder="Purpose (optional)" maxLength={1000} rows={2} /></label>
      </div>}

      {kind === "hardware" && <div className={styles.creationFields}>
        <label className={styles.field}><span>Asset name</span><input value={hardwareForm.name} onChange={(event) => { setHardwareForm((current) => ({ ...current, name: event.target.value })); setError(""); }} placeholder="Hardware name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={hardwareForm.barcode} onChange={(event) => { setHardwareForm((current) => ({ ...current, barcode: event.target.value })); setError(""); }} placeholder="Asset barcode" required /></label>
        <div className={styles.field}><span>Owner</span>{searchEmployees
          ? dialogOpen && <RegistryEmployeePicker value={hardwareForm.ownerId} onChange={ownerId => setHardwareForm(current => ({ ...current, ownerId }))} />
          : <select aria-label="Owner" value={hardwareForm.ownerId} onChange={(event) => setHardwareForm((current) => ({ ...current, ownerId: event.target.value }))} required><option value="" disabled>Choose an employee</option>{employees.filter((employee) => employee.type === "employee").sort((left, right) => left.name.localeCompare(right.name)).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.barcode}</option>)}</select>}</div>
        <label className={styles.field}><span>Category</span><input value={hardwareForm.category} onChange={(event) => { setHardwareForm((current) => ({ ...current, category: event.target.value })); setError(""); }} placeholder="Hardware category" required /></label>
        <label className={styles.field}><span>Allowed zone</span><select value={hardwareForm.allowedZone} required disabled={!zonesLoaded || !zones.length} onChange={(event) => setHardwareForm((current) => ({ ...current, allowedZone: event.target.value }))}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        <label className={styles.field}><span>Status</span><select value={hardwareForm.status} onChange={(event) => setHardwareForm((current) => ({ ...current, status: event.target.value as CreateHardwareAssetInput["status"] }))}><option value="active">Active</option><option value="restricted">Restricted</option><option value="maintenance">Maintenance</option></select></label>
      </div>}
    </CreationDialog>
  );
}
