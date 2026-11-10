"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Boxes, Loader2, MapPin, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";
import { useAdminRole } from "../../../context/AdminRoleContext";
import type { AccessPermission, Checkpoint, HardwareAsset, Person, PermissionRequest, PermissionRequestInput, SubjectProfile } from "../../../../lib/types";
import { checkpointDisplayName, facilityZoneLabel, formatFacilityZones, normalizeFacilityZones } from "../../../../lib/facilityZones";
import { accessDateTimeLimits, accessWindowBounds, parseFacilityDateTime, validateAccessWindow, type DateRangeErrors } from "../../../../lib/dateTimeValidation";
import { useDateTimeNow } from "../../../hooks/useDateTimeNow";
import { useOrganizationZones } from "../../../hooks/useOrganizationZones";
import { FacilityZoneSelection } from "./FacilityZoneSelection";
import { RegistrySubjectPicker } from "./RegistrySubjectPicker";
import { facilityDateInput, facilityDateIso, permissionWindowLabels, REQUEST_LABELS } from "./requestPresentation";
import styles from "./PermissionForm.module.css";

type FormPermissionType = "new_visitor" | "zone_access" | "hardware_custody";
type BackendPermissionType = Exclude<PermissionRequest["type"], "manual_override">;

export type RequestContext = { type?: PermissionRequest["type"]; subjectId?: string };

const NEW_REQUEST_TYPES = [
  { value: "zone_access", label: REQUEST_LABELS.zone_access, icon: MapPin },
  { value: "hardware_custody", label: REQUEST_LABELS.hardware_custody, icon: Boxes },
] satisfies Array<{ value: FormPermissionType; label: string; icon: typeof MapPin }>;

function contextType(context: RequestContext): FormPermissionType {
  if (context.type === "visitor") return context.subjectId ? "zone_access" : "new_visitor";
  if (context.type === "hardware_custody" || context.type === "zone_access") return context.type;
  return "zone_access";
}

function backendType(type: FormPermissionType, visitorSubject: boolean): BackendPermissionType {
  return type === "new_visitor" || visitorSubject ? "visitor" : type;
}

export function RequestDialog({ context, mode = "request", checkpoints: suppliedCheckpoints, onClose, onSubmitted, onReview, onRevokeAccess }: {
  context: RequestContext;
  mode?: "request" | "grant";
  checkpoints?: Checkpoint[];
  onClose: () => void;
  onSubmitted: (request: PermissionRequest, subjectGroup?: "people" | "hardware") => void;
  onReview: (requestId: string) => void;
  onRevokeAccess: (permission: AccessPermission) => Promise<boolean>;
}) {
  const { people: initialPeople, hardwareAssets: initialHardware, checkpoints: contextCheckpoints, permissions: initialPermissions, permissionRequests } = useDataState();
  const { submitPermissionRequest, createVisitor, grantPermission, releaseEntryRestriction, querySubjectProfile } = useDataActions();
  const { isMasterAdmin } = useAdminRole();
  const isZoneAdmin = !isMasterAdmin;
  const checkpoints = suppliedCheckpoints ?? contextCheckpoints;
  const [profile, setProfile] = useState<SubjectProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [selectedOption, setSelectedOption] = useState<Person | HardwareAsset>();
  const [selectedCarrier, setSelectedCarrier] = useState<Person>();
  const people = profile?.person ? [profile.person, ...initialPeople.filter(item => item.id !== profile.person!.id)] : initialPeople;
  const hardwareAssets = profile?.hardwareAsset ? [profile.hardwareAsset, ...initialHardware.filter(item => item.id !== profile.hardwareAsset!.id)] : initialHardware;
  const permissions = profile ? [...profile.permissions, ...initialPermissions.filter(item => item.subjectId !== (profile.person?.id ?? profile.hardwareAsset?.id))] : initialPermissions;
  const { zones: organizationZones } = useOrganizationZones();
  const zoneChoices = organizationZones.length ? organizationZones : [...new Set(checkpoints.map((item) => item.zoneId ?? item.zone))]
    .filter(Boolean).map((id) => ({ id, name: facilityZoneLabel(id, organizationZones), active: true, checkpoints: [] }));
  const isGrant = mode === "grant";
  const now = useDateTimeNow();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<FormPermissionType>(() => contextType(context));
  const [employeeAccessTab, setEmployeeAccessTab] = useState<"checkpoint" | "zone">("checkpoint");
  const [subjectId, setSubjectId] = useState(() => context.type === "visitor" && !context.subjectId ? "" : context.subjectId ?? "");
  const [targetZoneId, setTargetZoneId] = useState("");
  const [checkpointId, setCheckpointId] = useState(() => {
    const current = people.find((person) => person.id === context.subjectId);
    const currentScope = permissions.find((permission) => permission.subjectId === context.subjectId)?.checkpoints
      ?? current?.allowedCheckpoints;
    return checkpoints.find((item) => item.active !== false && currentScope?.includes(item.id))?.id
      ?? checkpoints.find((item) => item.active !== false)?.id
      ?? "";
  });
  const [checkpointIds, setCheckpointIds] = useState<string[]>(() => {
    const currentPermission = permissions.find((permission) => permission.subjectId === context.subjectId);
    const selectedSubject = [...people, ...hardwareAssets].find((item) => item.id === context.subjectId);
    const explicit = currentPermission?.checkpoints ?? selectedSubject?.allowedCheckpoints;
    if (explicit?.length) return [...explicit];
    const currentZones = currentPermission?.zones ?? selectedSubject?.allowedZones ?? [];
    return isZoneAdmin ? checkpoints.filter((item) => item.active !== false && currentZones.includes(item.zoneId ?? item.zone)).map((item) => item.id) : [];
  });
  const [carrierId, setCarrierId] = useState("");
  const [reason, setReason] = useState("");
  const [visitorDraft, setVisitorDraft] = useState({ name: "", barcode: "", host: "", company: "" });
  const [zones, setZones] = useState(() => normalizeFacilityZones(permissions.find((item) => item.subjectId === context.subjectId)?.zones ?? []));
  const [validFrom, setValidFrom] = useState(() => accessWindowBounds().defaultStart);
  const [validTo, setValidTo] = useState(() => facilityDateInput(new Date(parseFacilityDateTime(accessWindowBounds().defaultStart)! + 60 * 60_000)));
  const [startTouched, setStartTouched] = useState(false);
  const [endTouched, setEndTouched] = useState(false);
  const [permanentAccess, setPermanentAccess] = useState(() => mode === "grant" && contextType(context) === "zone_access" && context.type !== "visitor");
  const [dateErrors, setDateErrors] = useState<DateRangeErrors>({});
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [saving, setBusy] = useState(false);
  const busy = saving || profileLoading;
  const [revoking, setRevoking] = useState(false);
  const [releasingRestriction, setReleasingRestriction] = useState(false);
  const [restrictionReason, setRestrictionReason] = useState("");
  const [restrictionReasonInvalid, setRestrictionReasonInvalid] = useState(false);
  const [error, setError] = useState("");

  const selectablePeople = people.filter((person) => person.name.trim().toLowerCase() !== "unregistered barcode");
  const isNewVisitor = type === "new_visitor";
  const subjectOptionsFor = (selectedType: FormPermissionType) => selectedType === "hardware_custody"
    ? hardwareAssets
    : selectedType === "new_visitor" ? [] : [...selectablePeople, ...hardwareAssets];
  const subject = [...selectablePeople, ...hardwareAssets, ...(selectedOption ? [selectedOption] : [])].find((item) => item.id === subjectId);
  const asset = hardwareAssets.find((item) => item.id === subjectId);
  const currentCustodianId = asset?.assignedEmployeeId || asset?.ownerId;
  const isVisitorSubject = Boolean(subject && "type" in subject && subject.type === "visitor");
  const isVisitorAccess = type === "zone_access" && isVisitorSubject;
  const isVisitorType = isVisitorAccess || isNewVisitor;
  const requestType = backendType(type, isVisitorAccess);
  const checkpointScopedZoneAccess = isZoneAdmin && type === "zone_access" && !isVisitorAccess;
  const checkpointScopedNewVisitor = isZoneAdmin && isNewVisitor;
  const validSubject = Boolean(subject && (profile?.person?.id === subjectId || profile?.hardwareAsset?.id === subjectId) && (type !== "hardware_custody" || asset));
  const employee = selectedCarrier?.id === carrierId ? selectedCarrier : people.find((person) => person.id === carrierId && person.type === "employee");
  const checkpoint = checkpoints.find((item) => item.id === checkpointId && item.active !== false);
  const activeCheckpoints = checkpoints.filter((item) => item.active !== false);
  const selectedCheckpoints = activeCheckpoints.filter((item) => checkpointIds.includes(item.id));
  const currentPermission = permissions.find((item) => item.subjectId === subjectId);
  const currentZones = currentPermission?.zones ?? subject?.allowedZones ?? [];
  const isEmployeeSubject = Boolean(subject && "type" in subject && subject.type === "employee");
  const canRequestAnotherZone = isGrant && type === "zone_access" && isEmployeeSubject;
  const isCrossZoneRequest = canRequestAnotherZone && employeeAccessTab === "zone";
  const crossZoneOptions = zoneChoices.filter((zone) => zone.active !== false && !currentZones.includes(zone.id));
  const selectedTargetZoneId = crossZoneOptions.some((zone) => zone.id === targetZoneId)
    ? targetZoneId
    : crossZoneOptions[0]?.id ?? "";
  const permanentZoneAccess = isGrant && type === "zone_access" && !isVisitorAccess && !isCrossZoneRequest && permanentAccess;
  const canRevokeAccess = isGrant && currentPermission
    && currentPermission.state !== "pending_approval"
    && currentPermission.state !== "restricted"
    && currentPermission.state !== "revoked";
  const entryRestriction = currentPermission?.entryRestriction ?? subject?.entryRestriction;
  const dateLimits = accessDateTimeLimits(validFrom, validTo, now);
  const selectedCheckpointZones = normalizeFacilityZones(selectedCheckpoints.map((item) => item.zoneId ?? item.zone));
  const selectedVisitorZone = checkpointScopedNewVisitor && checkpoint
    ? normalizeFacilityZones([checkpoint.zoneId ?? checkpoint.zone]) : [];
  const requestedAccessZones = checkpointScopedZoneAccess ? selectedCheckpointZones
    : checkpointScopedNewVisitor ? selectedVisitorZone : normalizeFacilityZones(zones);
  const needsZones = !isVisitorAccess && !checkpointScopedZoneAccess && !checkpointScopedNewVisitor && (type === "zone_access" || isVisitorType);
  const needsDateWindow = isVisitorType || type === "zone_access";
  const needsCheckpointField = isVisitorAccess || checkpointScopedNewVisitor || (!isGrant && !isVisitorType);
  const selectedZoneIds = normalizeFacilityZones(zones);
  const visitorCheckpoint = checkpoints.find((item) => (item.zoneId ?? item.zone) === selectedZoneIds[0] && (item.required || item.number === 1))
    ?? checkpoints.find((item) => (item.zoneId ?? item.zone) === selectedZoneIds[0]);
  const permissionCheckpointId = isVisitorAccess || checkpointScopedNewVisitor ? checkpointId : isVisitorType ? visitorCheckpoint?.id ?? "" : checkpointId;
  const visitorBarcode = visitorDraft.barcode.trim();
  const visitorBarcodeValid = Boolean(visitorBarcode && visitorBarcode.length <= 64 && /^[A-Za-z0-9._:/-]+$/.test(visitorBarcode));
  const visitorRequest = permissionRequests.find((request) =>
    isVisitorAccess && request.type === "visitor" && request.subjectId === subjectId && request.status === "pending"
  );
  const invalidDateErrors = needsDateWindow
    ? validateAccessWindow(validFrom, validTo, now, permanentZoneAccess)
    : {};
  const subjectCheckpoints = subject && "allowedCheckpoints" in subject ? subject.allowedCheckpoints : undefined;
  const savedCheckpointScope = currentPermission?.checkpoints ?? subjectCheckpoints;
  const currentCheckpointScope = !savedCheckpointScope?.length
    ? activeCheckpoints.filter((item) => currentZones.includes(item.zoneId ?? item.zone)).map((item) => item.id)
    : savedCheckpointScope;
  const subjectStart = subject && "validFrom" in subject ? subject.validFrom : undefined;
  const subjectEnd = subject && "validTo" in subject ? subject.validTo : undefined;
  const currentWindow = permissionWindowLabels(currentPermission?.validFrom ?? subjectStart, currentPermission?.validTo ?? subjectEnd);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  useEffect(() => {
    setProfile(null);
    if (!subjectId) { setProfileLoading(false); return; }
    const controller = new AbortController();
    setProfileLoading(true);
    void querySubjectProfile(subjectId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setProfile(result);
      const saved = result.permissions.find(item => item.subjectId === subjectId);
      const record = result.person ?? result.hardwareAsset;
      setZones(normalizeFacilityZones(saved?.zones ?? record?.allowedZones ?? []));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load current access."); })
      .finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    return () => controller.abort();
  }, [subjectId, querySubjectProfile]);

  useEffect(() => {
    if (!isZoneAdmin || !profile || (profile.person?.id ?? profile.hardwareAsset?.id) !== subjectId) return;
    const saved = profile.permissions.find((item) => item.subjectId === subjectId);
    const record = profile.person ?? profile.hardwareAsset;
    const allowed = saved?.checkpoints ?? record?.allowedCheckpoints;
    if (allowed?.length) {
      setCheckpointIds([...allowed]);
      setCheckpointId(allowed[0]);
      return;
    }
    const currentZones = saved?.zones ?? record?.allowedZones ?? [];
    const legacyZoneCheckpoints = checkpoints.filter((item) => item.active !== false && currentZones.includes(item.zoneId ?? item.zone)).map((item) => item.id);
    setCheckpointIds(legacyZoneCheckpoints);
    if (legacyZoneCheckpoints.length) setCheckpointId(legacyZoneCheckpoints[0]);
  }, [checkpoints, isZoneAdmin, profile, subjectId]);

  useEffect(() => {
    if ((!checkpointId || !checkpoints.some((item) => item.id === checkpointId && item.active !== false)) && checkpoints.length) {
      setCheckpointId(checkpoints.find((item) => item.active !== false)?.id ?? "");
    }
  }, [checkpointId, checkpoints]);

  useEffect(() => {
    if (!isZoneAdmin && !zones.length && zoneChoices.length && (isNewVisitor || (context.type === "visitor" && isGrant))) {
      setZones([zoneChoices[0].id]);
    }
  }, [isZoneAdmin, zones, zoneChoices, isNewVisitor, context.type, isGrant]);

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
    setEmployeeAccessTab("checkpoint");
    setError("");
    setAttemptedSubmit(false);
    setDateErrors({});
    setPermanentAccess(isGrant && next === "zone_access");
    setCarrierId("");

    if (next === "new_visitor") {
      setSubjectId("");
    } else if (next === "hardware_custody") {
      if (!hardwareAssets.some((item) => item.id === subjectId)) setSubjectId("");
    } else if (!subjectOptionsFor(next).some((item) => item.id === subjectId)) {
      setSubjectId("");
    }

    if (!isZoneAdmin && next === "new_visitor" && !zones.length) {
      if (zoneChoices.length) setZones([zoneChoices[0].id]);
    }
  }

  function handleEmployeeAccessKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === "Home" ? "checkpoint"
      : event.key === "End" ? "zone"
      : employeeAccessTab === "checkpoint" ? "zone" : "checkpoint";
    setEmployeeAccessTab(nextTab);
    document.getElementById(nextTab === "checkpoint" ? "permission-checkpoint-tab" : "permission-zone-tab")?.focus();
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
    const duplicateCustodian = type === "hardware_custody" && Boolean(currentCustodianId && currentCustodianId === carrierId);
    const zonesMissing = needsZones && !normalizeFacilityZones(zones).length;
    const checkpointMissing = needsCheckpointField ? !checkpoint
      : checkpointScopedZoneAccess ? selectedCheckpoints.length === 0
        : isVisitorType && !permissionCheckpointId;

    if (checkpointMissing) { setError(checkpointScopedZoneAccess ? "Choose at least one checkpoint." : "Choose a checkpoint."); return; }
    if (nextDateErrors.start || nextDateErrors.end) { setError(nextDateErrors.start ?? nextDateErrors.end ?? "Choose a valid access window."); return; }
    if (visitorNameMissing || visitorHostMissing || visitorBarcodeMissing) {
      setError(!visitorDraft.name.trim() ? "Add the visitor name." : !visitorDraft.host.trim() ? "Add the visitor host." : "Enter a valid visitor barcode using letters, numbers, dots, underscores, colons, slashes, or hyphens.");
      return;
    }
    if (subjectMissing) { setError(isVisitorAccess ? "Choose a registered visitor." : type === "hardware_custody" ? "Choose registered hardware." : "Choose a registered subject."); return; }
    if (carrierMissing) { setError("Choose an employee to receive custody."); return; }
    if (duplicateCustodian) { setError("This employee already has custody of this asset."); return; }
    if (zonesMissing) { setError("Choose at least one zone."); return; }

    if (isCrossZoneRequest) {
      if (!isEmployeeSubject || !subject) { setError("Choose an employee for a zone access request."); return; }
      if (!selectedTargetZoneId) { setError("Choose an active zone the employee cannot currently access."); return; }
      if (!reason.trim()) { setError("Add a reason for requesting access to another zone."); return; }
      const duplicate = permissionRequests.find((request) =>
        request.status === "pending" && request.type === "zone_access" && request.origin === "cross_zone_request" &&
        request.subjectId === subjectId && request.targetZoneId === selectedTargetZoneId
      );
      if (duplicate) { setError("A request for this employee and zone is already awaiting review."); return; }

      setBusy(true);
      try {
        const request = await submitPermissionRequest({
          type: "zone_access",
          subjectId,
          subjectName: subject.name,
          barcode: subject.barcode,
          requester: "Administrator",
          purpose: reason.trim(),
          requestedZones: [],
          validFrom: "",
          validTo: "",
          targetZoneId: selectedTargetZoneId,
        });
        onSubmitted(request, "people");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to submit the zone access request. Your entries have been kept.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (isNewVisitor) {
      setBusy(true);
      try {
        if (isGrant) {
          const request = await grantPermission({
            type: "visitor", subjectId: "", subjectName: visitorDraft.name.trim(), barcode: visitorBarcode,
            requester: "Administrator", purpose: reason.trim(), requestedZones: requestedAccessZones, checkpointId: permissionCheckpointId,
            ...(checkpointScopedNewVisitor ? { requestedCheckpoints: [permissionCheckpointId] } : {}),
            validFrom: facilityDateIso(validFrom), validTo: facilityDateIso(validTo),
            newVisitor: { name: visitorDraft.name.trim(), host: visitorDraft.host.trim(), ...(visitorDraft.company.trim() ? { company: visitorDraft.company.trim() } : {}) },
          });
          onSubmitted(request, "people");
          return;
        }
        const result = await createVisitor({
          name: visitorDraft.name.trim(),
          barcode: visitorBarcode,
          host: visitorDraft.host.trim(),
          validFrom: facilityDateIso(validFrom),
          validTo: facilityDateIso(validTo),
          checkpointId: permissionCheckpointId,
          allowedZones: requestedAccessZones,
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
    const checkpointGrant = isGrant && type === "zone_access" && !isVisitorAccess;
    const requestedZones = type === "hardware_custody"
      ? []
      : checkpointGrant
        ? normalizeFacilityZones([checkpoint?.zoneId ?? checkpoint?.zone ?? ""])
      : isVisitorAccess
        ? normalizeFacilityZones([checkpoint?.zoneId ?? checkpoint?.zone ?? ""])
        : checkpointScopedZoneAccess || checkpointScopedNewVisitor
          ? requestedAccessZones
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
        ...(isVisitorAccess || checkpointScopedNewVisitor ? { requestedCheckpoints: [permissionCheckpointId] } : {}),
        ...(checkpointScopedZoneAccess ? { requestedCheckpoints: selectedCheckpoints.map((item) => item.id) } : {}),
        checkpointId: permissionCheckpointId,
        validFrom: needsDateWindow ? facilityDateIso(validFrom) : "",
        validTo: needsDateWindow && !permanentZoneAccess ? facilityDateIso(validTo) : "",
        ...(permanentZoneAccess ? { permanentAccess: true } : {}),
        ...(type === "hardware_custody" ? { hardwareId: subjectId, carrierId, carrierName: employee!.name } : {}),
      };
      const request = isGrant ? await grantPermission(input) : await submitPermissionRequest(input);
      onSubmitted(request, profile?.hardwareAsset ? "hardware" : "people");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isGrant ? "Unable to grant this permission. Your entries have been kept." : "Unable to submit this request. Your entries have been kept.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeCurrentAccess() {
    if (!currentPermission || busy || revoking) return;
    setRevoking(true);
    setError("");
    let closed = false;
    try {
      const revoked = await onRevokeAccess(currentPermission);
      if (!revoked) setError("Unable to revoke access. Please try again.");
      else {
        closed = true;
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke access. Please try again.");
    } finally {
      if (!closed) setRevoking(false);
    }
  }

  const invalidSubject = attemptedSubmit && !isNewVisitor && !validSubject;
  const invalidCheckpoint = attemptedSubmit && needsCheckpointField && !checkpoint;
  const invalidCheckpoints = attemptedSubmit && checkpointScopedZoneAccess && selectedCheckpoints.length === 0;
  const invalidCarrier = attemptedSubmit && type === "hardware_custody" && !employee;
  const invalidZones = attemptedSubmit && needsZones && !normalizeFacilityZones(zones).length;
  const visitorBarcodeError = attemptedSubmit && isNewVisitor && !visitorBarcodeValid;

  async function liftEntryRestriction() {
    const trimmedReason = restrictionReason.trim();
    const triggerAlertId = entryRestriction?.active ? entryRestriction.triggerAlertId : "";
    if (!triggerAlertId || !trimmedReason || busy || releasingRestriction) {
      if (!trimmedReason) setRestrictionReasonInvalid(true);
      return;
    }
    setReleasingRestriction(true);
    setError("");
    try {
      await releaseEntryRestriction(triggerAlertId, trimmedReason);
      setRestrictionReason("");
      setRestrictionReasonInvalid(false);
      // The dialog's selected profile is independent of the paginated page.
      // A successful release must be reflected here even if reconciliation fails.
      const released = <T extends { entryRestriction?: AccessPermission["entryRestriction"] }>(record: T): T => ({ ...record,
        entryRestriction: record.entryRestriction ? { ...record.entryRestriction, active: false } : undefined,
      });
      setProfile(current => current ? { ...current,
        person: current.person ? released(current.person) : undefined,
        hardwareAsset: current.hardwareAsset ? released(current.hardwareAsset) : undefined,
        permissions: current.permissions.map(released),
      } : current);
      await querySubjectProfile(subjectId).then(setProfile).catch(() => {
        setError("Entry restriction lifted. Close and reopen this permission to refresh its access details.");
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to lift the entry restriction. Please try again.");
    } finally {
      setReleasingRestriction(false);
    }
  }

  const checkpointAccessDialog = isVisitorAccess || checkpointScopedZoneAccess || checkpointScopedNewVisitor;
  const dialogTitle = isGrant ? checkpointAccessDialog ? "Checkpoint access" : "New permission" : "New request";
  const dialogDescription = isGrant
    ? checkpointScopedZoneAccess ? "Choose the checkpoints this person or asset can use and set its access window."
      : checkpointScopedNewVisitor ? "Choose one checkpoint for this visitor and set the access window."
        : isVisitorAccess ? "Choose one checkpoint and set this visitor’s access window." : "Grant access or reassign custody directly."
    : "Choose the approval you need.";

  return <dialog ref={dialogRef} className={`${styles.dialog} scrollable-content`} aria-labelledby="new-request-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit} noValidate className={styles.form}>
      <header className={styles.header}><div><h2 id="new-request-title">{dialogTitle}</h2><p>{dialogDescription}</p></div><button type="button" className={styles.close} aria-label={isGrant ? checkpointAccessDialog ? "Close checkpoint access" : "Close new permission" : "Close new request"} disabled={saving} onClick={onClose}><X size={19} /></button></header>

      <fieldset className={styles.typeSelector} disabled={busy}>
        <legend>{isGrant ? "Permission type" : "Request type"}</legend>
        <div className={styles.typeChoices}>{NEW_REQUEST_TYPES.map((item) => {
          const Icon = item.icon;
          const label = item.value === "zone_access" && (isVisitorAccess || isZoneAdmin) ? "Checkpoint access" : item.label;
          return <label key={item.value} className={styles.typeChoice} data-selected={type === item.value}>
            <input type="radio" name="permissionType" value={item.value} checked={type === item.value} onChange={() => changeType(item.value)} />
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>
          </label>;
        })}</div>
      </fieldset>

      <div className={`${styles.body} scrollable-content`}>

      {!isNewVisitor && <label className={styles.field}>
        <span>{type === "hardware_custody" ? "Asset" : isVisitorAccess ? "Visitor" : "Subject"}</span>
        <RegistrySubjectPicker key={type} value={subjectId} selected={subject} kind={type === "hardware_custody" ? "hardware" : undefined}
          label={type === "hardware_custody" ? "Asset" : isVisitorAccess ? "Visitor" : "Subject"} invalid={invalidSubject} disabled={busy}
          onChange={(selectedSubject) => {
          setSelectedOption(selectedSubject);
          setSubjectId(selectedSubject?.id ?? "");
          setEmployeeAccessTab("checkpoint");
          setTargetZoneId("");
          setCarrierId("");
          setSelectedCarrier(undefined);
          setZones([]);
          setCheckpointIds([]);
          if (selectedSubject && "type" in selectedSubject && selectedSubject.type === "visitor") setPermanentAccess(false);
          setError("");
        }} />
      </label>}

      {canRequestAnotherZone && <div className={styles.employeeAccessTabs} role="tablist" aria-label="Employee access action" onKeyDown={handleEmployeeAccessKeyDown}>
        <button id="permission-checkpoint-tab" type="button" role="tab" tabIndex={employeeAccessTab === "checkpoint" ? 0 : -1} aria-selected={employeeAccessTab === "checkpoint"} aria-controls="permission-checkpoint-panel" data-selected={employeeAccessTab === "checkpoint"} className={styles.employeeAccessTab} disabled={busy} onClick={() => { setEmployeeAccessTab("checkpoint"); setError(""); }}>Checkpoint access</button>
        <button id="permission-zone-tab" type="button" role="tab" tabIndex={employeeAccessTab === "zone" ? 0 : -1} aria-selected={employeeAccessTab === "zone"} aria-controls="permission-zone-panel" data-selected={employeeAccessTab === "zone"} className={styles.employeeAccessTab} disabled={busy} onClick={() => { setEmployeeAccessTab("zone"); setError(""); }}>Request another zone</button>
      </div>}

      {isGrant && entryRestriction?.active && <div className={`${styles.notice} ${styles.restriction}`}>
        <strong>Entry restriction remains active</strong>
        <p>This permission will not restore entry. Review the restriction and record a reason before lifting it.</p>
        {entryRestriction?.active && <>
          <label className={styles.field}>
            <span>Reason to lift restriction</span>
            <input value={restrictionReason} disabled={busy || releasingRestriction} maxLength={1000} aria-label={`Reason to lift entry restriction for ${currentPermission?.subjectName ?? subject?.name ?? "this subject"}`} aria-invalid={restrictionReasonInvalid} placeholder="Explain why entry can be restored." onChange={(event) => { setRestrictionReason(event.target.value); if (event.target.value.trim()) setRestrictionReasonInvalid(false); }} />
          </label>
          <button type="button" disabled={busy || releasingRestriction} className={styles.revokeAction} onClick={() => void liftEntryRestriction()}>
            {releasingRestriction ? <Loader2 className={styles.spinner} size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
            {releasingRestriction ? "Lifting restriction…" : "Lift entry restriction"}
          </button>
        </>}
      </div>}

      {isNewVisitor && <div className={styles.visitorFields}>
        <label className={styles.field}><span>Visitor name</span><input className="admin-surface" aria-invalid={attemptedSubmit && !visitorDraft.name.trim() || undefined} required maxLength={100} value={visitorDraft.name} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label className={styles.field}><span>Visitor barcode</span><input className="admin-surface" aria-invalid={visitorBarcodeError || undefined} required maxLength={64} autoCapitalize="none" spellCheck={false} value={visitorDraft.barcode} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, barcode: event.target.value }))} /></label>
        <label className={styles.field}><span>Host</span><input className="admin-surface" aria-invalid={attemptedSubmit && !visitorDraft.host.trim() || undefined} required maxLength={100} value={visitorDraft.host} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, host: event.target.value }))} /></label>
        <label className={styles.field}><span>Company</span><input className="admin-surface" maxLength={120} value={visitorDraft.company} disabled={busy} onChange={(event) => setVisitorDraft((current) => ({ ...current, company: event.target.value }))} /></label>
      </div>}

      {needsCheckpointField && <label className={styles.field}><span>Checkpoint</span><select className="admin-surface" aria-invalid={invalidCheckpoint || undefined} required disabled={busy} value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}><option value="">Choose a checkpoint</option>{checkpoints.filter((item) => item.active !== false).map((item) => <option key={item.id} value={item.id}>{facilityZoneLabel(item.zoneId ?? item.zone, organizationZones)} · {item.gateLabel && item.gateLabel.trim().toLowerCase() !== item.name.trim().toLowerCase() ? `${item.name} · ${item.gateLabel}` : item.gateLabel || item.name}</option>)}</select></label>}
      {needsCheckpointField && !activeCheckpoints.length && <p role="status">No active checkpoints are available in your assigned zones.</p>}

      {checkpointScopedZoneAccess && <fieldset className={`${styles.scopeSelection} admin-surface`} disabled={busy} aria-invalid={invalidCheckpoints || undefined}>
        <legend>Checkpoint access</legend>
        <p>Select up to 16 checkpoints this person or asset can use. Access will be limited to these checkpoints across your assigned zones.</p>
        <div className={styles.scopeChoices}>
          {activeCheckpoints.map((item) => <label key={item.id} className={styles.scopeChoice}>
            <input type="checkbox" checked={checkpointIds.includes(item.id)} disabled={!checkpointIds.includes(item.id) && checkpointIds.length >= 16} onChange={(event) => {
              const next = event.target.checked
                ? [...new Set([...checkpointIds, item.id])]
                : checkpointIds.filter((id) => id !== item.id);
              setCheckpointIds(next);
              if (next.length && !next.includes(checkpointId)) setCheckpointId(next[0]);
              setError("");
            }} />
            <span><strong>{facilityZoneLabel(item.zoneId ?? item.zone, organizationZones)}</strong><small>{item.gateLabel && item.gateLabel.trim().toLowerCase() !== item.name.trim().toLowerCase() ? `${item.name} · ${item.gateLabel}` : item.gateLabel || item.name}</small></span>
          </label>)}
          {!activeCheckpoints.length && <p role="status">No active checkpoints are available in your assigned zones.</p>}
        </div>
      </fieldset>}

      {type === "hardware_custody" && <label className={styles.field}><span>{isGrant ? "New custodian" : "Requested custodian"}</span><RegistrySubjectPicker value={carrierId} selected={employee} kind="employee" label="Employee" disabled={busy} invalid={invalidCarrier} onChange={record => { setSelectedCarrier(record as Person | undefined); setCarrierId(record?.id ?? ""); }} /></label>}

      {needsZones && <FacilityZoneSelection label={type === "zone_access" ? "Zone access" : "Allowed zones"} value={zones} onChange={(next) => { setZones(next); setError(""); }} zones={zoneChoices} disabled={busy || !zoneChoices.length} invalid={invalidZones} />}

      {isVisitorAccess && visitorRequest && <div className={styles.notice}><strong>Approval already pending</strong><p>{isGrant ? `Grant permission will approve ${visitorRequest.subjectName}'s pending visitor request using the selected checkpoint and access dates.` : `${visitorRequest.subjectName} is already awaiting review.`}</p>{!isGrant && <button type="button" className={styles.reviewAction} onClick={() => onReview(visitorRequest.id)}>Review pending permission <ArrowRight size={16} /></button>}</div>}

      {needsDateWindow && <div className={styles.dates}>
        <label className={styles.field}><span>Starts</span><input className="admin-surface" name="validFrom" type="datetime-local" required {...dateLimits.start} step={60} value={validFrom} disabled={busy} aria-invalid={Boolean(attemptedSubmit && invalidDateErrors.start)} aria-describedby={dateErrors.start ? "permission-start-error" : undefined} onChange={(event) => { setStartTouched(true); setValidFrom(event.target.value); setDateErrors((current) => ({ ...current, start: undefined })); }} />{dateErrors.start && <small id="permission-start-error" className={styles.dateError}>{dateErrors.start}</small>}</label>
        <div className={`${styles.field} ${styles.endDateField}`}>
          <label htmlFor="permission-valid-to">Ends</label>
          <input className="admin-surface" id="permission-valid-to" name="validTo" type="datetime-local" required={!permanentZoneAccess} {...dateLimits.end} step={60} value={permanentZoneAccess ? "" : validTo} disabled={busy || permanentZoneAccess} aria-invalid={Boolean(attemptedSubmit && invalidDateErrors.end)} aria-describedby={dateErrors.end ? "permission-end-error" : undefined} onChange={(event) => { setEndTouched(true); setValidTo(event.target.value); setDateErrors((current) => ({ ...current, end: undefined })); }} />
          {dateErrors.end && <small id="permission-end-error" className={styles.dateError}>{dateErrors.end}</small>}
          {type === "zone_access" && !isVisitorAccess && isGrant && <label className={styles.permanentToggle}><input type="checkbox" checked={permanentAccess} disabled={busy} onChange={(event) => { setPermanentAccess(event.target.checked); setDateErrors((current) => ({ ...current, end: undefined })); }} /><span>Until further notice</span></label>}
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
              {type === "zone_access"
                ? <p><strong>Checkpoint access:</strong> {(() => {
                  const subjectCheckpoints = subject && "allowedCheckpoints" in subject ? subject.allowedCheckpoints : undefined;
                  const allowedCheckpoints = isZoneAdmin
                    ? currentCheckpointScope
                    : currentPermission?.checkpoints?.length ? currentPermission.checkpoints : subjectCheckpoints;
                  if (allowedCheckpoints?.length) return allowedCheckpoints.map((id) => {
                    const item = checkpoints.find((candidate) => candidate.id === id);
                    return item ? `${facilityZoneLabel(item.zoneId ?? item.zone, organizationZones)} · ${checkpointDisplayName(item, organizationZones)}` : id;
                  }).join(", ");
                  return !isZoneAdmin && currentZones.length
                    ? `All checkpoints in ${formatFacilityZones(currentZones, organizationZones)} (current zone-wide access)`
                    : "No checkpoint access assigned";
                })()}</p>
                : <p><strong>Zones:</strong> {formatFacilityZones(currentZones, organizationZones) || "No zones assigned"}</p>}
              {type !== "hardware_custody" && <p className={styles.currentAccessWindow}><span>{currentWindow.start}</span><span>{currentWindow.end}</span></p>}
              {canRevokeAccess && <button type="button" className={styles.revokeAction} disabled={busy || revoking} onClick={() => void revokeCurrentAccess()}><ShieldAlert size={16} aria-hidden="true" />{revoking ? "Revoking…" : "Revoke access"}</button>}
            </>}
      </section>}

      </div>

      <footer className={styles.footer}><button type="button" className={styles.cancelButton} disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className={styles.submitButton} disabled={busy || (type === "hardware_custody" && currentCustodianId === carrierId) || Boolean(!isGrant && visitorRequest)}>{busy ? <><Loader2 size={16} className={styles.spinner} />{isGrant ? "Granting…" : "Submitting…"}</> : <>{isGrant ? checkpointAccessDialog ? "Grant checkpoint access" : "Grant permission" : isNewVisitor ? "Register & request approval" : "Submit request"}<ArrowRight size={16} aria-hidden="true" /></>}</button></footer>
    </form>
  </dialog>;
}
