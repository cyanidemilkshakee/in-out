"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronRight, KeyRound, LoaderCircle, LockKeyhole, MapPin, Plus, ScanLine, Search, ShieldCheck, Trash2, UserRound, UsersRound, X } from "lucide-react";
import { createManagedUser, deleteManagedUser, endManagedUserSessions, getManagedUser, listManagedUsers, resetManagedUserPassword, updateManagedUser, type ManagedUser } from "../../../services/keycloakUserService";
import { createCheckpoint as createCheckpointRecord, deleteCheckpoint as deleteCheckpointRecord, listCheckpoints } from "../../../services/checkpointService";
import { createZone, deleteZone, listZones } from "../../../services/zoneService";
import type { Checkpoint, OrganizationZone } from "../../../lib/types";
import { DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, USER_MANAGEMENT_STEP_UP_DURATIONS, formatStepUpCountdown, isStepUpDurationMinutes } from "../../../lib/userManagementStepUp";
import { CreateUserForm, UserDetailsForm, type ManagedUserFormValue } from "./ManagedUserForm";
import { StepUpDurationSelect } from "./StepUpDurationSelect";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../../../lib/passwordLimits";
import styles from "./UserManagement.module.css";

const emptyForm: ManagedUserFormValue = {
  username: "", firstName: "", lastName: "", email: "", password: "",
  temporaryPassword: true, enabled: true, roles: [], checkpointId: null, zoneIds: [],
};
type CreateContext = { role: "zone-admin" | "operator"; zoneId?: string; checkpointId?: string };
type Operation = "load" | "details" | "create" | "save" | "password" | "sessions" | "delete" | "checkpoint" | "zone";
type Message = { text: string; kind: "success" | "error" } | null;

function userName(user: ManagedUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;
}

function userInitials(user: ManagedUser) {
  const names = [user.firstName, user.lastName].filter(Boolean);
  return (names.length ? names.map((name) => name[0]).join("") : user.username.slice(0, 2)).toUpperCase();
}

function canDeleteAccount(user: ManagedUser) {
  const roles = user.roles ?? [];
  return user.canManage && roles.length > 0 && !roles.includes("master-admin") &&
    roles.every((role) => role === "zone-admin" || role === "operator");
}

function formForUser(user: ManagedUser): ManagedUserFormValue {
  return {
    username: user.username, firstName: user.firstName, lastName: user.lastName,
    email: user.email, password: "", temporaryPassword: true, enabled: user.enabled,
    roles: (user.roles ?? []).filter((role): role is "zone-admin" | "operator" => role === "zone-admin" || role === "operator"), checkpointId: user.checkpointId ?? null,
    zoneIds: user.zoneIds ?? [],
  };
}

export function UserManagement({ isMasterAdmin, stepUpExpiresAt, stepUpDurationMinutes = DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES }: {
  isMasterAdmin: boolean;
  stepUpExpiresAt?: number;
  stepUpDurationMinutes?: number;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [assignmentUsers, setAssignmentUsers] = useState<ManagedUser[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "disabled">("all");
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createContext, setCreateContext] = useState<CreateContext | null>(null);
  const [showCheckpointForm, setShowCheckpointForm] = useState(false);
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpointZone, setCheckpointZone] = useState("a");
  const [checkpointPreset, setCheckpointPreset] = useState<"back_gate" | "custom">("back_gate");
  const [zoneName, setZoneName] = useState("");
  const [showZoneForm, setShowZoneForm] = useState(false);
  const [checkpointMessage, setCheckpointMessage] = useState<Message>(null);
  const [zoneMessage, setZoneMessage] = useState<Message>(null);
  const [createForm, setCreateForm] = useState<ManagedUserFormValue>(emptyForm);
  const [editForm, setEditForm] = useState<ManagedUserFormValue>(emptyForm);
  const [newPassword, setNewPassword] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState(true);
  const [message, setMessage] = useState<Message>(null);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [securityAction, setSecurityAction] = useState<"lock" | "extend" | null>(null);
  const pending = useRef(false);
  const securityPending = useRef(false);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const busy = operation !== null || securityAction !== null;
  const [durationMinutes, setDurationMinutes] = useState<(typeof USER_MANAGEMENT_STEP_UP_DURATIONS)[number]>(() => isStepUpDurationMinutes(stepUpDurationMinutes) ? stepUpDurationMinutes : DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const stepUpSecondsRemaining = stepUpExpiresAt ? Math.max(0, Math.ceil(stepUpExpiresAt - now / 1_000)) : 0;
  const stepUpCountdown = formatStepUpCountdown(stepUpSecondsRemaining);
  useEffect(() => {
    if (!isMasterAdmin && stepUpSecondsRemaining === 0) window.location.assign("/admin/users");
  }, [isMasterAdmin, stepUpSecondsRemaining]);

  useEffect(() => {
    if (!selected) return;
    editorHeadingRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1100px)").matches) {
      editorHeadingRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [selected?.id]);

  function beginOperation(action: Operation) {
    if (pending.current || securityPending.current) return false;
    pending.current = true;
    setOperation(action);
    return true;
  }

  function finishOperation() {
    pending.current = false;
    setOperation(null);
  }

  async function load(query = search) {
    if (!beginOperation("load")) return;
    setLoadError("");
    setMessage(null);
    try {
      const [result, checkpointList, zoneList] = await Promise.all([listManagedUsers(query), listCheckpoints(), listZones()]);
      setUsers(result.items);
      if (!query.trim()) setAssignmentUsers(result.items);
      setCheckpoints(checkpointList);
      setZones(zoneList);
      if (!checkpointList.some((item) => item.zoneId === checkpointZone)) setCheckpointZone(checkpointList[0]?.zoneId ?? zoneList[0]?.id ?? "");
      setAppliedSearch(query.trim());
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : isMasterAdmin ? "Unable to load application accounts." : "Unable to load operators in your zones.");
    } finally {
      finishOperation();
    }
  }
  useEffect(() => { void load(""); }, []);

  async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !beginOperation("checkpoint")) return;
    setCheckpointMessage(null);
    try {
      const created = await createCheckpointRecord({ zoneId: checkpointZone, preset: checkpointPreset,
        ...(checkpointPreset === "custom" ? { name: checkpointName.trim() } : {}) });
      setCheckpoints((current) => [...current.filter((item) => item.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)));
      setCheckpointName("");
      setCheckpointPreset("back_gate");
      setShowCheckpointForm(false);
      setSelected(null);
      setCreateContext({ role: "operator", zoneId: created.zoneId ?? checkpointZone, checkpointId: created.id });
      setCreateForm({ ...emptyForm, roles: ["operator"], checkpointId: created.id });
      setMessage(null);
      setShowCreate(true);
      setCheckpointMessage({ kind: "success", text: `Checkpoint ${created.name} created and ready for assignment.` });
    } catch (error) {
      setCheckpointMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to create checkpoint." });
    } finally {
      finishOperation();
    }
  }

  async function removeCheckpoint(checkpoint: Checkpoint) {
    if (checkpoint.required || !window.confirm(`Retire checkpoint ${checkpoint.name}? Historical movement records will remain.`) || !beginOperation("checkpoint")) return;
    setCheckpointMessage(null);
    try {
      await deleteCheckpointRecord(checkpoint.id);
      setCheckpoints((current) => current.filter((item) => item.id !== checkpoint.id));
      setCheckpointMessage({ kind: "success", text: `Checkpoint ${checkpoint.name} retired.` });
    } catch (error) {
      setCheckpointMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to retire checkpoint." });
    } finally { finishOperation(); }
  }

  async function addZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isMasterAdmin || !event.currentTarget.reportValidity() || !beginOperation("zone")) return;
    setZoneMessage(null);
    try {
      const created = await createZone(zoneName.trim());
      setZones((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCheckpoints((current) => [...current, ...created.checkpoints]);
      setZoneName("");
      setShowZoneForm(false);
      setShowCheckpointForm(false);
      setSelected(null);
      setCreateContext({ role: "zone-admin", zoneId: created.id });
      setCreateForm({ ...emptyForm, roles: ["zone-admin"], zoneIds: [created.id] });
      setMessage(null);
      setShowCreate(true);
      setCheckpointZone(created.id);
      setZoneMessage({ kind: "success", text: `${created.name} created with its required Front Gate and optional Back Gate.` });
    } catch (error) {
      setZoneMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to create zone." });
    } finally { finishOperation(); }
  }

  async function removeZone(zone: OrganizationZone) {
    if (!isMasterAdmin || !window.confirm(`Retire ${zone.name}? Historical records remain, but operators and pending requests must be reassigned or resolved first.`) || !beginOperation("zone")) return;
    setZoneMessage(null);
    try {
      await deleteZone(zone.id);
      setZones((current) => current.filter((item) => item.id !== zone.id));
      setCheckpoints((current) => current.filter((item) => item.zoneId !== zone.id));
      setZoneMessage({ kind: "success", text: `${zone.name} retired.` });
    } catch (error) {
      setZoneMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to retire zone." });
    } finally { finishOperation(); }
  }

  function showUser(user: ManagedUser) {
    setShowCreate(false);
    setCreateContext(null);
    setSelected(user);
    setEditForm(formForUser(user));
    setNewPassword("");
    setTemporaryPassword(true);
    setMessage(null);
  }

  async function choose(user: ManagedUser) {
    if (!beginOperation("details")) return;
    setMessage(null);
    try {
      const details = await getManagedUser(user.id);
      showUser(details);
      setUsers((current) => current.map((item) => item.id === details.id ? details : item));
      setAssignmentUsers((current) => current.map((item) => item.id === details.id ? details : item));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to load user details." });
    } finally {
      finishOperation();
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isMasterAdmin && (createForm.roles.length !== 1 || createForm.roles[0] !== "operator" || createForm.zoneIds.length > 0)) return;
    if (!event.currentTarget.reportValidity() || !beginOperation("create")) return;
    setMessage(null);
    try {
      const created = await createManagedUser(createForm);
      setUsers((current) => [created, ...current.filter((user) => user.id !== created.id)]);
      setAssignmentUsers((current) => [created, ...current.filter((user) => user.id !== created.id)]);
      setCreateForm(emptyForm);
      showUser(created);
      setEditForm(formForUser(created));
      setMessage({ kind: "success", text: isMasterAdmin ? "Application account created." : "Operator account created." });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Unable to create user.";
      try {
        const refreshed = await listManagedUsers(appliedSearch);
        setUsers(refreshed.items);
        if (!appliedSearch) setAssignmentUsers(refreshed.items);
      }
      catch { setLoadError("Reload the directory to check the current account state."); }
      setMessage({ kind: "error", text: failure });
    } finally {
      finishOperation();
    }
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.canManage || !event.currentTarget.reportValidity() || !beginOperation("save")) return;
    setMessage(null);
    try {
      const updated = await updateManagedUser(selected.id, isMasterAdmin ? {
        firstName: editForm.firstName, lastName: editForm.lastName, email: editForm.email,
        enabled: editForm.enabled, checkpointId: editForm.checkpointId ?? null, roles: editForm.roles,
        zoneIds: editForm.zoneIds,
      } : { enabled: editForm.enabled, checkpointId: editForm.checkpointId ?? null });
      setUsers((current) => current.map((user) => user.id === selected.id ? updated : user));
      setAssignmentUsers((current) => current.map((user) => user.id === selected.id ? updated : user));
      setSelected(updated);
      setEditForm(formForUser(updated));
      setMessage({ kind: "success", text: isMasterAdmin ? "Account changes saved." : "Operator access updated." });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Unable to save user.";
      try {
        // A timed-out response or failed compensation can leave a provider
        // change persisted. Always display its actual state before another edit.
        const actual = await getManagedUser(selected.id);
        setSelected(actual);
        setEditForm(formForUser(actual));
        setUsers((current) => current.map((user) => user.id === actual.id ? actual : user));
        setAssignmentUsers((current) => current.map((user) => user.id === actual.id ? actual : user));
        setMessage({ kind: "error", text: failure });
      } catch {
        setSelected(null);
        setMessage({ kind: "error", text: `${failure} Reload the directory before editing this account again.` });
      }
    } finally {
      finishOperation();
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isMasterAdmin || !selected?.canManage || !event.currentTarget.reportValidity() || !beginOperation("password")) return;
    setMessage(null);
    try {
      await resetManagedUserPassword(selected.id, newPassword, temporaryPassword);
      setNewPassword("");
      setMessage({ kind: "success", text: "Password reset" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to reset password." });
    } finally {
      finishOperation();
    }
  }

  async function endSessions() {
    if (!isMasterAdmin || !selected?.canManage || !beginOperation("sessions")) return;
    setMessage(null);
    try {
      await endManagedUserSessions(selected.id);
      setMessage({ kind: "success", text: "Sessions ended" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to end sessions." });
    } finally {
      finishOperation();
    }
  }

  async function deleteAccount() {
    const target = selected;
    if (!isMasterAdmin || !target || !canDeleteAccount(target) ||
        !window.confirm(`Permanently delete ${userName(target)} (@${target.username})? Their zone/checkpoint assignments will be removed. Historical scans will remain.`) ||
        !beginOperation("delete")) return;
    setMessage(null);
    try {
      await deleteManagedUser(target.id);
      setUsers((current) => current.filter((user) => user.id !== target.id));
      setAssignmentUsers((current) => current.filter((user) => user.id !== target.id));
      setSelected(null);
      setMessage({ kind: "success", text: `Account @${target.username} deleted.` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to delete account." });
    } finally {
      finishOperation();
    }
  }

  async function lock() {
    if (pending.current || securityPending.current) return;
    securityPending.current = true;
    setSecurityAction("lock");
    setMessage(null);
    try {
      const response = await fetch("/api/auth/step-up", { method: "DELETE", cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Unable to lock user management. Please try again.");
      window.location.assign("/admin/users");
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to lock user management. Please try again." });
      securityPending.current = false;
      setSecurityAction(null);
    }
  }

  async function extend() {
    if (pending.current || securityPending.current) return;
    securityPending.current = true;
    setSecurityAction("extend");
    setMessage(null);
    try {
      window.location.assign(`/login?stepUp=1&from=%2Fadmin%2Fusers&durationMinutes=${durationMinutes}`);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to start re-authentication." });
      securityPending.current = false;
      setSecurityAction(null);
    }
  }

  function openCreate(role: "zone-admin" | "operator", assignment: Omit<CreateContext, "role"> = {}) {
    if (pending.current || securityPending.current) return;
    setShowZoneForm(false);
    setShowCheckpointForm(false);
    setSelected(null);
    const context = { role, ...assignment };
    setCreateContext(context);
    setCreateForm({
      ...emptyForm,
      roles: [role],
      checkpointId: context?.checkpointId ?? (!isMasterAdmin && checkpoints.length === 1 ? checkpoints[0].id : null),
      zoneIds: role === "zone-admin" && context?.zoneId ? [context.zoneId] : [],
    });
    setMessage(null);
    setShowCreate(true);
  }

  function toggleZoneForm() {
    if (busy) return;
    setShowCreate(false);
    setCreateContext(null);
    setZoneMessage(null);
    setCheckpointMessage(null);
    setShowCheckpointForm(false);
    setShowZoneForm((open) => !open);
  }

  function toggleCheckpointForm(zoneId?: string) {
    if (busy || zones.length === 0) return;
    setShowCreate(false);
    setCreateContext(null);
    const isSameForm = showCheckpointForm && (!zoneId || checkpointZone === zoneId);
    if (zoneId) setCheckpointZone(zoneId);
    setCheckpointMessage(null);
    setZoneMessage(null);
    setShowZoneForm(false);
    setShowCheckpointForm(!isSameForm);
  }

  function closeCreate() {
    if (pending.current || securityPending.current) return;
    setShowCreate(false);
    setCreateContext(null);
    setMessage(null);
  }

  function clearSearch() {
    if (pending.current || securityPending.current) return;
    setSearch("");
    setStateFilter("all");
    void load("");
  }

  const visibleUsers = useMemo(() => users.filter((user) => stateFilter === "all" || user.enabled === (stateFilter === "active")), [users, stateFilter]);
  const accountCounts = useMemo(() => ({
    all: users.length,
    active: users.filter((user) => user.enabled).length,
    disabled: users.filter((user) => !user.enabled).length,
  }), [users]);
  const zoneGroups = useMemo(() => zones.map((zone) => {
    const zoneCheckpoints = checkpoints.filter((checkpoint) => (checkpoint.zoneId ?? checkpoint.zone) === zone.id)
      .sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
    const zoneAdmins = visibleUsers.filter((user) => user.roles?.includes("zone-admin") && user.zoneIds?.includes(zone.id));
    const operators = visibleUsers.filter((user) => user.roles?.includes("operator") && zoneCheckpoints.some((checkpoint) => checkpoint.id === user.checkpointId));
    return {
      zone,
      checkpoints: zoneCheckpoints,
      zoneAdmins,
      operators,
      memberCount: new Set([...zoneAdmins, ...operators].map((user) => user.id)).size,
    };
  }), [zones, checkpoints, visibleUsers]);
  const assignmentVisibleUsers = useMemo(() => {
    const needle = appliedSearch.toLocaleLowerCase();
    return assignmentUsers.filter((user) => {
      if (stateFilter !== "all" && user.enabled !== (stateFilter === "active")) return false;
      if (!needle) return true;
      return [user.username, user.firstName, user.lastName, user.email, userName(user)]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [assignmentUsers, appliedSearch, stateFilter]);
  const checkpointOperators = useMemo(() => {
    const grouped = new Map<string, ManagedUser[]>();
    for (const user of isMasterAdmin ? visibleUsers : assignmentVisibleUsers) {
      if (!user.roles?.includes("operator") || !user.checkpointId) continue;
      const operators = grouped.get(user.checkpointId) ?? [];
      operators.push(user);
      grouped.set(user.checkpointId, operators);
    }
    for (const operators of grouped.values()) operators.sort((left, right) => userName(left).localeCompare(userName(right)));
    return grouped;
  }, [isMasterAdmin, visibleUsers, assignmentVisibleUsers]);
  const zoneMemberIds = new Set(zoneGroups.flatMap((group) => [...group.zoneAdmins, ...group.operators].map((user) => user.id)));
  const globalAccounts = visibleUsers.filter((user) => !zoneMemberIds.has(user.id));
  const hasAccountFilters = Boolean(appliedSearch || stateFilter !== "all");
  const selectedName = selected ? userName(selected) : "";
  const hasChanges = selected?.canManage ? (
    editForm.firstName !== selected.firstName || editForm.lastName !== selected.lastName ||
    editForm.email !== selected.email || editForm.enabled !== selected.enabled ||
    (editForm.checkpointId ?? null) !== (selected.checkpointId ?? null) ||
    [...editForm.roles].sort().join(",") !== [...(selected.roles ?? [])].sort().join(",") ||
    [...editForm.zoneIds].sort().join(",") !== [...(selected.zoneIds ?? [])].sort().join(",")
  ) : false;
  function renderUserCreateBox(role: "zone-admin" | "operator", context: Omit<CreateContext, "role"> = {}) {
    const isOpen = showCreate && createContext?.role === role &&
      (createContext.zoneId ?? "") === (context.zoneId ?? "") &&
      (createContext.checkpointId ?? "") === (context.checkpointId ?? "");
    if (!isOpen) return null;
    const label = role === "zone-admin" ? "zone admin" : "operator";
    const location = context.checkpointId
      ? checkpoints.find((checkpoint) => checkpoint.id === context.checkpointId)?.gateLabel || checkpoints.find((checkpoint) => checkpoint.id === context.checkpointId)?.name
      : context.zoneId ? zones.find((zone) => zone.id === context.zoneId)?.name : null;
    const Icon = role === "zone-admin" ? ShieldCheck : UserRound;
    return <section className={styles.inlineCreateBox} aria-label={`Create ${label}`}>
      <header className={styles.inlineCreateHeader}>
        <div><span className={styles.creationFormIcon}><Icon size={19} aria-hidden="true" /></span><div><h5>Create {label}</h5><p>{location ? `For ${location}` : "Add an account to this list"}</p></div></div>
        <button className={styles.closeButton} type="button" aria-label={`Cancel creating ${label}`} title="Cancel" disabled={busy} onClick={closeCreate}><X size={18} aria-hidden="true" /></button>
      </header>
      {message ? <p className={styles.statusMessage} data-kind={message.kind} role={message.kind === "error" ? "alert" : "status"}>{message.kind === "success" ? <Check size={18} aria-hidden="true" /> : null}{message.text}</p> : null}
      <CreateUserForm form={createForm} onChange={setCreateForm} busy={busy} onSubmit={create} onCancel={closeCreate} checkpoints={checkpoints} zones={zones} restrictedToOperator={!isMasterAdmin} submitLabel={role === "zone-admin" ? "Create zone admin" : "Create operator"} />
    </section>;
  }

  function renderAccountRow(user: ManagedUser, group: "Zone admin" | "Operator" | "Global account") {
    const roles = (user.roles ?? []).filter((role) => role !== "zone-admin" || !user.roles?.includes("master-admin"))
      .map((role) => role === "master-admin" ? "Master admin" : role === "zone-admin" ? "Zone admin" : "Operator").join(", ") || "No role";
    return <button className={styles.zoneAccount} key={`${group}-${user.id}`} type="button"
      aria-label={`${user.canManage ? "Manage" : "View"} ${group.toLowerCase()} ${userName(user)}`}
      aria-pressed={selected?.id === user.id} data-selected={selected?.id === user.id} disabled={busy} onClick={() => void choose(user)}>
      <span className={styles.accountAvatar} data-enabled={user.enabled} aria-hidden="true">{userInitials(user)}</span>
      <span className={styles.zoneAccountIdentity}>
        <strong>{userName(user)}</strong>
        <small>@{user.username}{group === "Global account" ? ` · ${roles}` : ""}</small>
      </span>
      <span className={styles.statusBadge} data-enabled={user.enabled}>{user.enabled ? "Active" : "Disabled"}</span>
      <ChevronRight className={styles.accountChevron} size={17} aria-hidden="true" />
    </button>;
  }
  function renderZoneAccountGroup(title: "Zone admins" | "Operators", members: ManagedUser[], group: "Zone admin" | "Operator", zoneId: string) {
    const canAddAdmin = isMasterAdmin && group === "Zone admin";
    return <section className={styles.zoneAccountGroup} aria-label={title}>
      <header className={styles.accountListHeader}>
        <div className={styles.accountListHeading}>
          <h4>{title}<span className={styles.accountCount}>{members.length}</span></h4>
          {members.length === 0 ? <span className={styles.requiredSetupBadge}>Required</span> : null}
        </div>
        {canAddAdmin ? <button className={styles.listAddAction} type="button" aria-label={`Add zone admin to ${zones.find((zone) => zone.id === zoneId)?.name ?? "zone"}`} title="Add zone admin" aria-expanded={showCreate && createContext?.role === "zone-admin" && createContext.zoneId === zoneId} disabled={busy} onClick={() => openCreate("zone-admin", { zoneId })}><Plus size={19} aria-hidden="true" /></button> : null}
      </header>
      {renderUserCreateBox("zone-admin", { zoneId })}
      {members.length
        ? <div className={styles.zoneAccountList}>{members.map((user) => renderAccountRow(user, group))}</div>
        : <p>{hasAccountFilters ? "No matching accounts" : group === "Zone admin" ? "No zone admin assigned" : "No operators assigned"}</p>}
    </section>;
  }
  function renderCheckpointOperators(checkpoint: Checkpoint) {
    const operators = checkpointOperators.get(checkpoint.id) ?? [];
    const zoneId = checkpoint.zoneId ?? checkpoint.zone;
    return <section className={styles.checkpointOperators} aria-label={`Operators assigned to ${checkpoint.name}`}>
      <header className={styles.accountListHeader}>
        <div className={styles.accountListHeading}>
          <h4>Operators<span className={styles.accountCount}>{operators.length}</span></h4>
          {operators.length === 0 ? <span className={styles.requiredSetupBadge}>Required</span> : null}
        </div>
        <button className={styles.listAddAction} type="button" aria-label={`Add operator to ${checkpoint.gateLabel || checkpoint.name}`} title="Add operator" aria-expanded={showCreate && createContext?.role === "operator" && createContext.checkpointId === checkpoint.id} disabled={busy} onClick={() => openCreate("operator", { zoneId, checkpointId: checkpoint.id })}><Plus size={19} aria-hidden="true" /></button>
      </header>
      {renderUserCreateBox("operator", { zoneId, checkpointId: checkpoint.id })}
      {operators.length ? <ul className={styles.checkpointOperatorList}>
        {operators.map((user) => <li key={user.id}>{renderAccountRow(user, "Operator")}</li>)}
      </ul> : <p>{hasAccountFilters ? "No matching operators" : "No operator assigned"}</p>}
    </section>;
  }
  const zoneCreateForm = <form id="create-zone" className={styles.checkpointForm} onSubmit={addZone}>
    <header className={styles.creationFormHeader}><span className={styles.creationFormIcon}><MapPin size={20} aria-hidden="true" /></span><div><h3>Create zone</h3><p>Organization branch</p></div></header>
    <label className={styles.field}><span>Zone name</span><input required minLength={1} maxLength={80} value={zoneName} disabled={busy} onChange={(event) => setZoneName(event.target.value)} placeholder="For example, Zone C" /></label>
    <div className={styles.checkpointFormActions}>
      <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setShowZoneForm(false)}>Cancel</button>
      <button className={styles.primaryButton} type="submit" disabled={busy || !zoneName.trim()}>{operation === "zone" ? <LoaderCircle className={styles.loadingIcon} size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}Create zone</button>
    </div>
  </form>;
  const checkpointCreateForm = (fixedZoneId?: string) => <form id={`create-checkpoint-${fixedZoneId ?? "any"}`} className={styles.checkpointForm} onSubmit={createCheckpoint}>
    <header className={styles.creationFormHeader}><span className={styles.creationFormIcon}><ScanLine size={20} aria-hidden="true" /></span><div><h3>Create checkpoint</h3><p>{fixedZoneId ? `New checkpoint in ${zones.find((zone) => zone.id === fixedZoneId)?.name ?? "this zone"}` : "Assign it to a zone"}</p></div></header>
    {fixedZoneId ? <div className={`${styles.field} ${styles.fixedZoneField}`}><span>Zone</span><strong>{zones.find((zone) => zone.id === fixedZoneId)?.name ?? fixedZoneId}</strong></div> : <label className={styles.field}><span>Zone</span><select required value={checkpointZone} disabled={busy} onChange={(event) => setCheckpointZone(event.target.value)}>
      {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
    </select></label>}
    <label className={styles.field}><span>Checkpoint type</span><select value={checkpointPreset} disabled={busy} onChange={(event) => setCheckpointPreset(event.target.value as "back_gate" | "custom")}>
      <option value="back_gate">Back Gate (2)</option><option value="custom">Additional checkpoint</option>
    </select></label>
    {checkpointPreset === "custom" ? <label className={styles.field}><span>Checkpoint name</span><input required minLength={2} maxLength={80} value={checkpointName} disabled={busy} onChange={(event) => setCheckpointName(event.target.value)} placeholder="For example, Loading Bay" /></label> : null}
    <div className={styles.checkpointFormActions}>
      <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setShowCheckpointForm(false)}>Cancel</button>
      <button className={styles.primaryButton} type="submit" disabled={busy || !checkpointZone || (checkpointPreset === "custom" && checkpointName.trim().length < 2)}>{operation === "checkpoint" ? <LoaderCircle className={styles.loadingIcon} size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}Create checkpoint</button>
    </div>
  </form>;
  const checkpointPanel = <section className={`${styles.panel} ${styles.checkpointPanel}`} aria-labelledby="checkpoint-management-title" aria-busy={operation === "checkpoint"}>
    <div className={styles.checkpointHeader}>
      <div><h2 id="checkpoint-management-title">Your checkpoints</h2></div>
      <button className={styles.listAddAction} type="button" aria-label="Add checkpoint" title="Add checkpoint" aria-expanded={showCheckpointForm} disabled={busy || zones.length === 0} onClick={() => toggleCheckpointForm()}><Plus size={19} aria-hidden="true" /></button>
    </div>
    {showCheckpointForm ? checkpointCreateForm() : null}
    {checkpointMessage ? <p className={styles.statusMessage} data-kind={checkpointMessage.kind} role={checkpointMessage.kind === "error" ? "alert" : "status"}>{checkpointMessage.kind === "success" ? <Check size={18} aria-hidden="true" /> : null}{checkpointMessage.text}</p> : null}
    <ul className={styles.checkpointList}>
      {checkpoints.map((checkpoint) => <li className={styles.checkpointCard} key={checkpoint.id}>
        <div className={styles.checkpointCardInfo}>
          <span className={styles.checkpointName}><MapPin size={18} aria-hidden="true" /><strong>{checkpoint.gateLabel || checkpoint.name}</strong></span>
          <span className={styles.checkpointMeta}>Checkpoint {checkpoint.number ?? "—"} · {checkpoint.required ? "Required" : "Optional"}</span>
          {!checkpoint.required ? <button className={styles.dangerButton} type="button" disabled={busy} aria-label={`Retire checkpoint ${checkpoint.name}`} onClick={() => void removeCheckpoint(checkpoint)}><Trash2 size={16} aria-hidden="true" />Retire</button> : null}
        </div>
        {renderCheckpointOperators(checkpoint)}
      </li>)}
    </ul>
  </section>;

  return (
    <main className={styles.page} data-master-admin={isMasterAdmin} aria-label="User management">
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1>{isMasterAdmin ? "User management" : "Operators in your zones"}</h1>
          {!isMasterAdmin ? <p className={styles.description}>Manage operators and checkpoint assignments.</p> : null}
          {!isMasterAdmin ? <p className={styles.scopeSummary} aria-live="polite"><MapPin size={17} aria-hidden="true" /><strong>Zone access:</strong> {loaded ? zones.length ? `${zones.length} assigned ${zones.length === 1 ? "zone" : "zones"}` : "No zones assigned. Ask a master admin to assign one." : "Loading assigned zones…"}</p> : null}
        </div>
      </header>

      {!isMasterAdmin ? <section className={styles.unlockBar} aria-label="Temporary user-management access">
        <div className={styles.unlockStatus} data-expiring={stepUpSecondsRemaining <= 60} aria-label={`User management access expires in ${stepUpCountdown}`}>
          <span className={styles.unlockIcon}><ShieldCheck size={21} aria-hidden="true" /></span>
          <span className={styles.unlockLabel}>Unlocked</span>
          <time className={styles.countdown} aria-label={`Re-authentication expires in ${stepUpCountdown}`}>{stepUpCountdown}</time>
        </div>
        <div className={styles.accessControls}>
          <StepUpDurationSelect value={durationMinutes} onChange={setDurationMinutes} disabled={busy} label="Duration" />
          <button className={styles.secondaryButton} type="button" aria-label="Re-authenticate to extend access" title={securityAction === "extend" ? "Opening sign-in…" : "Re-authenticate to extend access"} disabled={busy} onClick={() => void extend()}>
            {securityAction === "extend" ? <LoaderCircle className={styles.loadingIcon} size={18} aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}Extend
          </button>
          <button className={styles.secondaryButton} type="button" aria-label="Lock user management now" title={securityAction === "lock" ? "Locking…" : "Lock user management now"} disabled={busy} onClick={() => void lock()}>
            {securityAction === "lock" ? <LoaderCircle className={styles.loadingIcon} size={18} aria-hidden="true" /> : <LockKeyhole size={18} aria-hidden="true" />}Lock
          </button>
        </div>
      </section> : null}

      {message && !showCreate ? (
        <p className={styles.statusMessage} data-kind={message.kind} role={message.kind === "error" ? "alert" : "status"}>
          {message.kind === "success" ? <Check size={18} aria-hidden="true" /> : null}{message.text}
        </p>
      ) : null}

      <div className={styles.workspace} data-selected={Boolean(selected)}>
        <section className={styles.panel} aria-labelledby="directory-title" aria-busy={operation === "load" || operation === "details"}>
          <div className={styles.directoryHeader}>
                <div className={styles.titleRow}>
              <div>
                <span className={styles.sectionIcon}><UsersRound size={22} aria-hidden="true" /></span>
                <div><h2 id="directory-title">{isMasterAdmin ? "Accounts by zone" : "Operator accounts"}<span className={styles.directoryCount}>{loaded ? visibleUsers.length : "—"}</span></h2></div>
              </div>
                  {!isMasterAdmin ? <button className={styles.listAddAction} type="button" aria-label="Add operator" title={checkpoints.length === 0 ? "A checkpoint in your assigned zones is required" : "Add operator"} aria-expanded={showCreate && createContext?.role === "operator"} disabled={busy || checkpoints.length === 0} onClick={() => openCreate("operator")}><Plus size={19} aria-hidden="true" /></button> : null}
            </div>
                {!isMasterAdmin ? renderUserCreateBox("operator") : null}
            <div className={styles.directoryToolbar}>
            <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); void load(); }}>
              <input aria-label={isMasterAdmin ? "Search accounts" : "Search operators"} maxLength={100} value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder={isMasterAdmin ? "Name, username or email" : "Search operators"} />
              {search || appliedSearch ? (
                <button className={styles.clearButton} type="button" aria-label="Clear search" disabled={busy} onClick={clearSearch}>
                  <X size={17} aria-hidden="true" />
                </button>
              ) : null}
              <button className={styles.searchButton} type="submit" aria-label={isMasterAdmin ? "Search accounts" : "Search operators"} title="Search" disabled={busy}><Search size={17} aria-hidden="true" /></button>
            </form>
            <div className={styles.filterRow}>
              <div className={styles.stateFilter} role="group" aria-label={isMasterAdmin ? "Filter account status" : "Filter operator status"}>
                {(["all", "active", "disabled"] as const).map((filter) => (
                  <button key={filter} type="button" aria-pressed={stateFilter === filter} disabled={busy} onClick={() => setStateFilter(filter)}>
                    {filter === "all" ? "All" : filter === "active" ? "Active" : "Disabled"}<span>{loaded ? accountCounts[filter] : "—"}</span>
                  </button>
                ))}
              </div>
            </div>
            </div>
          </div>

          {loadError ? (
            <div className={styles.emptyState} role="alert">
              <span className={styles.emptyIcon}><UsersRound size={26} aria-hidden="true" /></span>
              <h3>{isMasterAdmin ? "Unable to load management data" : "Unable to load your operators"}</h3>
              <p>{loadError}</p>
              <button className={styles.secondaryButton} disabled={busy} type="button" onClick={() => void load()}>Try again</button>
            </div>
          ) : null}
          {operation === "load" && !loaded ? (
            <div className={styles.emptyState} role="status">
              <LoaderCircle className={styles.loadingIcon} size={28} aria-hidden="true" />
              <h3>Loading…</h3>
            </div>
          ) : null}
          {operation === "load" && loaded ? (
            <p className={styles.statusMessage} role="status">
              <LoaderCircle className={styles.loadingIcon} size={18} aria-hidden="true" /> Updating…
            </p>
          ) : null}
          {operation === "details" ? (
            <p className={styles.statusMessage} role="status">
              <LoaderCircle className={styles.loadingIcon} size={18} aria-hidden="true" /> Loading…
            </p>
          ) : null}

          <div className={`${styles.directoryGrid} ${isMasterAdmin ? styles.zoneDirectory : ""} scrollable-content`}>
            {isMasterAdmin ? <>
              <section className={styles.zoneListSection} aria-labelledby="zone-list-title">
                <header className={styles.listSectionHeader}>
                  <div><h3 id="zone-list-title">Zones</h3><span className={styles.directoryCount}>{loaded ? zones.length : "—"}</span></div>
                  <button className={styles.listAddAction} type="button" aria-label="Add zone" title="Add zone" aria-expanded={showZoneForm} disabled={busy} onClick={toggleZoneForm}><Plus size={19} aria-hidden="true" /></button>
                </header>
                {zoneMessage ? <p className={styles.statusMessage} data-kind={zoneMessage.kind} role={zoneMessage.kind === "error" ? "alert" : "status"}>{zoneMessage.kind === "success" ? <Check size={18} aria-hidden="true" /> : null}{zoneMessage.text}</p> : null}
                {showZoneForm ? zoneCreateForm : null}
                <div className={styles.zoneListItems}>
              {zoneGroups.filter(({ memberCount }) => !hasAccountFilters || memberCount > 0).map(({ zone, checkpoints: zoneCheckpoints, zoneAdmins, memberCount }) => <article className={styles.zoneCard} key={zone.id}>
                <div className={styles.zoneHeading}>
                  <div className={styles.zoneTitle}><span className={styles.zoneIcon}><MapPin size={21} aria-hidden="true" /></span><h3>{zone.name}</h3></div>
                  <span className={styles.zoneSummary}>{zoneCheckpoints.length} {zoneCheckpoints.length === 1 ? "checkpoint" : "checkpoints"}<span aria-hidden="true">·</span>{memberCount} {memberCount === 1 ? "account" : "accounts"}</span>
                  <button className={`${styles.dangerButton} ${styles.retireButton}`} type="button" disabled={busy} aria-label={`Retire zone ${zone.name}`} title={`Retire ${zone.name}`} onClick={() => void removeZone(zone)}><Trash2 size={17} aria-hidden="true" /></button>
                </div>
                <div className={styles.zoneDetails}>
                  <div className={styles.zoneCheckpointSummary}>
                    <header className={styles.listSectionHeader}>
                      <div><h4>Checkpoints</h4><span className={styles.directoryCount}>{zoneCheckpoints.length}</span></div>
                      <button className={styles.listAddAction} type="button" aria-label={`Add checkpoint to ${zone.name}`} title="Add checkpoint" aria-expanded={showCheckpointForm && checkpointZone === zone.id} disabled={busy} onClick={() => toggleCheckpointForm(zone.id)}><Plus size={19} aria-hidden="true" /></button>
                    </header>
                    {checkpointMessage && checkpointZone === zone.id ? <p className={styles.statusMessage} data-kind={checkpointMessage.kind} role={checkpointMessage.kind === "error" ? "alert" : "status"}>{checkpointMessage.kind === "success" ? <Check size={18} aria-hidden="true" /> : null}{checkpointMessage.text}</p> : null}
                    {showCheckpointForm && checkpointZone === zone.id ? checkpointCreateForm(zone.id) : null}
                    <div className={styles.zoneCheckpointList}>
                      {zoneCheckpoints.length ? zoneCheckpoints.map((checkpoint) => <div className={styles.checkpointCard} key={checkpoint.id}>
                        <div className={styles.checkpointCardInfo}>
                          <span className={styles.checkpointName}><span className={styles.checkpointNumber} aria-label={`Checkpoint ${checkpoint.number ?? "unnumbered"}`}>{checkpoint.number != null ? String(checkpoint.number).padStart(2, "0") : "—"}</span><strong>{checkpoint.gateLabel || checkpoint.name}</strong></span>
                          <span className={styles.checkpointMeta}>{checkpoint.required ? "Required" : "Optional"}</span>
                          {!checkpoint.required ? <button className={`${styles.dangerButton} ${styles.retireButton}`} type="button" disabled={busy} aria-label={`Retire checkpoint ${checkpoint.name}`} title={`Retire ${checkpoint.name}`} onClick={() => void removeCheckpoint(checkpoint)}><Trash2 size={16} aria-hidden="true" /></button> : null}
                        </div>
                        {renderCheckpointOperators(checkpoint)}
                      </div>) : <span className={styles.zoneEmpty}>No checkpoints</span>}
                    </div>
                  </div>
                </div>
                <div className={styles.zoneAccountGroups}>
                  {renderZoneAccountGroup("Zone admins", zoneAdmins, "Zone admin", zone.id)}
                </div>
              </article>)}
                </div>
                {loaded && !zones.length ? <div className={styles.emptyState}><span className={styles.emptyIcon}><MapPin size={26} aria-hidden="true" /></span><h3>No zones yet</h3><p>Create a zone to organize its checkpoints and operator accounts.</p></div> : null}
              </section>
              {globalAccounts.length ? <section className={styles.globalAccounts} aria-label="Global and unassigned accounts">
                <h3>Global & unassigned<span className={styles.directoryCount}>{globalAccounts.length}</span></h3>
                <div className={styles.globalAccountList}>{globalAccounts.map((user) => renderAccountRow(user, "Global account"))}</div>
              </section> : null}
            </> : visibleUsers.map((user) => {
              const checkpoint = checkpoints.find((item) => item.id === user.checkpointId);
              return (
                <button className={styles.userCard} key={user.id} type="button" aria-label={`${user.canManage ? "Manage" : "View"} ${userName(user)}`} aria-pressed={selected?.id === user.id} data-selected={selected?.id === user.id} disabled={busy} onClick={() => void choose(user)}>
                  <span className={styles.cardHeader}>
                    <span className={styles.cardIdentityGroup}>
                      <span className={styles.avatar} data-enabled={user.enabled}>{userInitials(user)}</span>
                      <span className={styles.cardIdentity}>
                        <span className={styles.nameRoleRow}>
                          <span className={styles.userName}>{userName(user)}</span>
                          {user.roles ? <span className={styles.roleList}>
                            {user.roles.length ? user.roles.filter((role) => role !== "zone-admin" || !user.roles?.includes("master-admin")).map((role) => (
                              <span key={role} className={styles.roleBadge} data-role={role}>{role === "zone-admin" ? "Zone admin" : role === "master-admin" ? "Master admin" : "Operator"}</span>
                            )) : <span className={styles.roleBadge}>No role</span>}
                          </span> : null}
                        </span>
                        <span className={styles.username}>@{user.username}</span>
                        {user.email ? <span>{user.email}</span> : null}
                      </span>
                    </span>
                    <span className={styles.cardAccessSummary}>
                      <span className={styles.statusBadge} data-enabled={user.enabled}>{user.enabled ? "Active" : "Disabled"}</span>
                      <span className={styles.checkpointLine}>
                        <MapPin size={16} aria-hidden="true" /><span>{checkpoint ? `${zones.find((zone) => zone.id === checkpoint.zoneId)?.name ?? `Zone ${checkpoint.zone.toUpperCase()}`} · ${checkpoint.name}` : user.zoneIds?.length ? user.zoneIds.map((id) => zones.find((zone) => zone.id === id)?.name ?? id).join(", ") : "Unassigned"}</span>
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {loaded && operation !== "load" && !loadError && !visibleUsers.length ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}><Search size={26} aria-hidden="true" /></span>
              <h3>{appliedSearch || stateFilter !== "all" ? isMasterAdmin ? "No matching accounts" : "No matching operators" : isMasterAdmin ? "No application accounts yet" : "No operators in your zones yet"}</h3>
              {appliedSearch || stateFilter !== "all" ? <button className={styles.secondaryButton} type="button" aria-label="Clear filters" title="Clear filters" disabled={busy} onClick={clearSearch}><X size={18} aria-hidden="true" /></button> : null}
            </div>
          ) : null}
        </section>

        {selected ? (
          <section className={`${styles.panel} ${styles.editor} scrollable-content`} aria-labelledby="edit-user-title">
            <div className={styles.editorHeader}>
              <div className={styles.selectedIdentity}>
                <span className={styles.avatar} data-enabled={selected.enabled}>{userInitials(selected)}</span>
                <div className={styles.identityDetails}>
                  <h2 id="edit-user-title" ref={editorHeadingRef} className={styles.editorHeading} tabIndex={-1}>{selectedName}</h2>
                  <div className={styles.identityMeta}>
                    <p>@{selected.username}</p>
                    {!isMasterAdmin ? <span className={styles.roleBadge} data-role="operator">Operator</span> : null}
                    {!isMasterAdmin && selected.email ? <p>{selected.email}</p> : null}
                    <span className={styles.statusBadge} data-enabled={editForm.enabled}>{editForm.enabled ? "Active" : "Disabled"}</span>
                    {hasChanges ? <span className={styles.draftBadge} title="Unsaved changes">Unsaved</span> : null}
                  </div>
                </div>
                {isMasterAdmin && selected.canManage ? <label className={styles.enabledToggle}>
                  <input type="checkbox" checked={editForm.enabled} disabled={busy} onChange={(event) => setEditForm((current) => ({ ...current, enabled: event.target.checked }))} />
                  <span>Enabled</span>
                </label> : null}
              </div>
              <button className={styles.closeButton} type="button" disabled={busy} aria-label="Close user details" onClick={() => {
                if (!pending.current && !securityPending.current) { setSelected(null); setMessage(null); }
              }}>
                <X size={21} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.editorBody}>
              {selected.canManage ? <UserDetailsForm form={editForm} onChange={setEditForm} busy={busy} onSubmit={saveUser} accessOnly={!isMasterAdmin} checkpoints={checkpoints} zones={zones} /> : <p className={styles.statusMessage} role="status">{isMasterAdmin ? "This account is protected and cannot be edited here." : "This account is view-only here. Only a master admin can manage administrator accounts."}</p>}
              {isMasterAdmin && selected.canManage ? <section className={styles.securityPanel} aria-label="Security settings">
                <div className={styles.securityHeader}>
                  <h3><KeyRound size={18} aria-hidden="true" />Security</h3>
                  <div className={styles.securityActionRow}>
                    <button className={styles.dangerButton} type="button" aria-label="End sessions" title={operation === "sessions" ? "Ending sessions…" : "End sessions"} disabled={busy} onClick={() => void endSessions()}>
                      {operation === "sessions" ? <LoaderCircle className={styles.loadingIcon} size={16} aria-hidden="true" /> : null}End sessions
                    </button>
                    {canDeleteAccount(selected) ? <button className={styles.dangerButton} type="button" aria-label={`Delete ${selected.username}`} title={operation === "delete" ? "Deleting account…" : "Delete account"} disabled={busy} onClick={() => void deleteAccount()}>
                      {operation === "delete" ? <LoaderCircle className={styles.loadingIcon} size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}Delete account
                    </button> : null}
                  </div>
                </div>
                <form className={styles.passwordForm} onSubmit={resetPassword}>
                  <label className={styles.field}>
                    New password
                    <input required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} type="password" autoComplete="new-password" disabled={busy} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 12 characters" />
                  </label>
                  <label className={styles.checkRow}>
                    <input type="checkbox" checked={temporaryPassword} disabled={busy} onChange={(event) => setTemporaryPassword(event.target.checked)} />
                    <span>Change at sign-in</span>
                  </label>
                  <div className={styles.securityActionRow}>
                    <button className={styles.secondaryButton} type="submit" aria-label="Reset password" title={operation === "password" ? "Resetting…" : "Reset password"} disabled={busy || !newPassword.trim()}>
                      {operation === "password" ? <LoaderCircle className={styles.loadingIcon} size={16} aria-hidden="true" /> : null}Reset password
                    </button>
                  </div>
                </form>
              </section> : null}
            </div>
          </section>
        ) : null}
      </div>

      {!isMasterAdmin ? checkpointPanel : null}
    </main>
  );
}
