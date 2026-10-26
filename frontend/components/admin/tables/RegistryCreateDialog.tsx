"use client";

import { useEffect, useState } from "react";
import { Package, UserRound, UsersRound } from "lucide-react";
import type { Checkpoint, CreateEmployeeInput, CreateHardwareAssetInput, CreateVisitorInput, Person } from "../../../../lib/types";
import { accessWindowBounds, parseFacilityDateTime } from "../../../../lib/dateTimeValidation";
import { FACILITY_ZONES } from "../../../../lib/facilityZones";
import { facilityDateInput } from "../permissions/requestPresentation";
import { FacilityZoneSelection } from "../permissions/FacilityZoneSelection";
import { CreationDialog } from "./CreationDialog";
import { RegistryEmployeePicker } from "./RegistryEmployeePicker";
import styles from "../permissions/PermissionForm.module.css";
import registryStyles from "./RegistryCreateDialog.module.css";

export type RegistryCreateKind = "employee" | "visitor" | "hardware";

const initialEmployee: CreateEmployeeInput = {
  name: "",
  barcode: "",
  status: "active",
  allowedZones: [],
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
  const checkpoint = checkpoints.find((item) => item.zone === zoneId) ?? checkpoints[0];
  return {
    ...initialVisitor(checkpoint?.id ?? ""),
    allowedZones: checkpoint ? [checkpoint.zone] : [],
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
  const zones = FACILITY_ZONES;
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (!dialogOpen || !zones.length) return;
    setEmployeeForm((current) => current.allowedZones?.length
      ? current
      : { ...current, allowedZones: zones.map((zone) => zone.id) });
    setHardwareForm((current) => current.allowedZone
      ? current
      : { ...current, allowedZone: zones[0].id });
    setVisitorForm((current) => current.checkpointId
      ? current
      : visitorDefaults(checkpoints, zones[0].id));
  }, [checkpoints, dialogOpen, zones]);

  const title = kind === "employee" ? "Create employee" : kind === "visitor" ? "Create visitor" : "Create hardware";
  const submitLabel = title;

  function open() {
    setKind(initialKind);
    setEmployeeForm({ ...initialEmployee, allowedZones: zones.map((zone) => zone.id) });
    setVisitorForm(visitorDefaults(checkpoints, zones[0]?.id));
    setHardwareForm({ ...initialHardware, allowedZone: zones[0]?.id ?? "" });
    setError("");
  }

  async function submit() {
    try {
      if (kind === "employee") await onCreateEmployee(employeeForm);
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
      <fieldset className={`${styles.typeSelector} ${registryStyles.typeSelector}`}>
        <legend>Record type</legend>
        <div className={styles.typeChoices}>
          {([
            ["employee", "Employee", UserRound],
            ["visitor", "Visitor", UsersRound],
            ["hardware", "Hardware", Package],
          ] as const).map(([value, label, Icon]) => (
            <label key={value} className={`${styles.typeChoice} ${registryStyles.typeChoice}`} data-selected={kind === value}>
              <input type="radio" name="registryRecordType" value={value} checked={kind === value} onChange={() => changeKind(value)} />
              <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "employee" && <div className={`${styles.creationFields} ${registryStyles.fields}`}>
        <label className={styles.field}><span>Name</span><input value={employeeForm.name} onChange={(event) => { setEmployeeForm((current) => ({ ...current, name: event.target.value })); setError(""); }} placeholder="Employee name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={employeeForm.barcode} onChange={(event) => { setEmployeeForm((current) => ({ ...current, barcode: event.target.value })); setError(""); }} placeholder="Employee barcode" required /></label>
        <label className={styles.field}><span>Status</span><select value={employeeForm.status} onChange={(event) => setEmployeeForm((current) => ({ ...current, status: event.target.value as CreateEmployeeInput["status"] }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <div className={styles.creationFieldSpan}><FacilityZoneSelection label="Allowed zones" value={employeeForm.allowedZones ?? []} onChange={(allowedZones) => setEmployeeForm((current) => ({ ...current, allowedZones }))} /></div>
      </div>}

      {kind === "visitor" && <div className={`${styles.creationFields} ${registryStyles.fields}`}>
        <label className={styles.field}><span>Name</span><input value={visitorForm.name} onChange={(event) => setVisitorForm((current) => ({ ...current, name: event.target.value }))} placeholder="Visitor name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={visitorForm.barcode} autoCapitalize="none" spellCheck={false} onChange={(event) => setVisitorForm((current) => ({ ...current, barcode: event.target.value }))} placeholder="Visitor barcode" required /></label>
        <label className={styles.field}><span>Host</span><input value={visitorForm.host} onChange={(event) => setVisitorForm((current) => ({ ...current, host: event.target.value }))} placeholder="Host employee" required /></label>
        <label className={styles.field}><span>Company</span><input value={visitorForm.company ?? ""} onChange={(event) => setVisitorForm((current) => ({ ...current, company: event.target.value }))} placeholder="Company (optional)" /></label>
        <label className={styles.field}><span>Valid from</span><input type="datetime-local" value={visitorForm.validFrom} onChange={(event) => setVisitorForm((current) => ({ ...current, validFrom: event.target.value }))} required /></label>
        <label className={styles.field}><span>Valid to</span><input type="datetime-local" value={visitorForm.validTo} onChange={(event) => setVisitorForm((current) => ({ ...current, validTo: event.target.value }))} required /></label>
        <label className={styles.field}><span>Checkpoint</span><select value={visitorForm.checkpointId} onChange={(event) => {
          const checkpoint = checkpoints.find((item) => item.id === event.target.value);
          setVisitorForm((current) => ({ ...current, checkpointId: event.target.value, allowedZones: checkpoint ? [checkpoint.zone] : [] }));
        }} required><option value="">Choose a checkpoint</option>{checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.name}</option>)}</select></label>
        <label className={`${styles.field} ${styles.creationFieldSpan}`}><span>Purpose</span><textarea value={visitorForm.purpose ?? ""} onChange={(event) => setVisitorForm((current) => ({ ...current, purpose: event.target.value }))} placeholder="Purpose (optional)" maxLength={1000} rows={2} /></label>
      </div>}

      {kind === "hardware" && <div className={`${styles.creationFields} ${registryStyles.fields}`}>
        <label className={styles.field}><span>Asset name</span><input value={hardwareForm.name} onChange={(event) => { setHardwareForm((current) => ({ ...current, name: event.target.value })); setError(""); }} placeholder="Hardware name" required autoFocus /></label>
        <label className={styles.field}><span>Barcode</span><input value={hardwareForm.barcode} onChange={(event) => { setHardwareForm((current) => ({ ...current, barcode: event.target.value })); setError(""); }} placeholder="Asset barcode" required /></label>
        <div className={styles.field}><span>Owner</span>{searchEmployees
          ? dialogOpen && <RegistryEmployeePicker value={hardwareForm.ownerId} onChange={ownerId => setHardwareForm(current => ({ ...current, ownerId }))} />
          : <select aria-label="Owner" value={hardwareForm.ownerId} onChange={(event) => setHardwareForm((current) => ({ ...current, ownerId: event.target.value }))} required><option value="" disabled>Choose an employee</option>{employees.filter((employee) => employee.type === "employee").sort((left, right) => left.name.localeCompare(right.name)).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.barcode}</option>)}</select>}</div>
        <label className={styles.field}><span>Category</span><input value={hardwareForm.category} onChange={(event) => { setHardwareForm((current) => ({ ...current, category: event.target.value })); setError(""); }} placeholder="Hardware category" required /></label>
        <label className={styles.field}><span>Allowed zone</span><select value={hardwareForm.allowedZone} required onChange={(event) => setHardwareForm((current) => ({ ...current, allowedZone: event.target.value }))}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
        <label className={styles.field}><span>Status</span><select value={hardwareForm.status} onChange={(event) => setHardwareForm((current) => ({ ...current, status: event.target.value as CreateHardwareAssetInput["status"] }))}><option value="active">Active</option><option value="restricted">Restricted</option><option value="maintenance">Maintenance</option></select></label>
      </div>}
    </CreationDialog>
  );
}
