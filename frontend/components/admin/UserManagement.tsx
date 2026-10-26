"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, KeyRound, LoaderCircle, LockKeyhole, MapPin, Plus, Search, ShieldCheck, UserRound, UsersRound, X } from "lucide-react";
import { createManagedUser, endManagedUserSessions, getManagedUser, listManagedUsers, resetManagedUserPassword, updateManagedUser, type ManagedUser } from "../../../services/keycloakUserService";
import { FACILITY_CHECKPOINTS } from "../../../lib/facilityZones";
import { DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES, USER_MANAGEMENT_STEP_UP_DURATIONS, formatStepUpCountdown, isStepUpDurationMinutes } from "../../../lib/userManagementStepUp";
import { CreateUserForm, UserDetailsForm, type ManagedUserFormValue } from "./ManagedUserForm";
import { StepUpDurationSelect } from "./StepUpDurationSelect";
import { PasswordRequirements } from "../PasswordRequirements";
import { isPasswordValid, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE } from "../../../lib/passwordPolicy";
import styles from "./UserManagement.module.css";

const emptyForm: ManagedUserFormValue = {
  username: "", firstName: "", lastName: "", email: "", password: "",
  temporaryPassword: true, enabled: true, roles: [], checkpointId: null,
};
type Operation = "load" | "details" | "create" | "save" | "password" | "sessions";
type Message = { text: string; kind: "success" | "error" } | null;

function userName(user: ManagedUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;
}

function userInitials(user: ManagedUser) {
  const names = [user.firstName, user.lastName].filter(Boolean);
  return (names.length ? names.map((name) => name[0]).join("") : user.username.slice(0, 2)).toUpperCase();
}

function formForUser(user: ManagedUser): ManagedUserFormValue {
  return {
    username: user.username, firstName: user.firstName, lastName: user.lastName,
    email: user.email, password: "", temporaryPassword: true, enabled: user.enabled,
    roles: (user.roles ?? []).filter((role): role is "admin" | "operator" => role === "admin" || role === "operator"), checkpointId: user.checkpointId ?? null,
  };
}

export function UserManagement({ stepUpExpiresAt, stepUpDurationMinutes = DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES }: {
  stepUpExpiresAt: number;
  stepUpDurationMinutes?: number;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const checkpoints = FACILITY_CHECKPOINTS;
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "disabled">("all");
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const busy = operation !== null || securityAction !== null;
  const [durationMinutes, setDurationMinutes] = useState<(typeof USER_MANAGEMENT_STEP_UP_DURATIONS)[number]>(() => isStepUpDurationMinutes(stepUpDurationMinutes) ? stepUpDurationMinutes : DEFAULT_USER_MANAGEMENT_STEP_UP_MINUTES);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const stepUpSecondsRemaining = Math.max(0, Math.ceil(stepUpExpiresAt - now / 1_000));
  const stepUpCountdown = formatStepUpCountdown(stepUpSecondsRemaining);
  useEffect(() => {
    if (stepUpSecondsRemaining === 0) window.location.assign("/admin/users");
  }, [stepUpSecondsRemaining]);

  useEffect(() => {
    if (showCreate && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
  }, [showCreate]);

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
      const result = await listManagedUsers(query);
      setUsers(result.items);
      setAppliedSearch(query.trim());
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load users.");
    } finally {
      finishOperation();
    }
  }
  useEffect(() => { void load(""); }, []);

  function showUser(user: ManagedUser) {
    setShowCreate(false);
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
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to load user details." });
    } finally {
      finishOperation();
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    if (!isPasswordValid(createForm.password)) {
      setMessage({ kind: "error", text: PASSWORD_POLICY_MESSAGE });
      return;
    }
    if (!beginOperation("create")) return;
    setMessage(null);
    try {
      const created = await createManagedUser(createForm);
      setUsers((current) => [created, ...current.filter((user) => user.id !== created.id)]);
      setCreateForm(emptyForm);
      showUser(created);
      setMessage({ kind: "success", text: "Created" });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Unable to create user.";
      try { setUsers((await listManagedUsers(appliedSearch)).items); }
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
      const updated = await updateManagedUser(selected.id, {
        firstName: editForm.firstName, lastName: editForm.lastName, email: editForm.email,
        enabled: editForm.enabled, checkpointId: editForm.checkpointId ?? null, roles: editForm.roles,
      });
      setUsers((current) => current.map((user) => user.id === selected.id ? updated : user));
      setSelected(updated);
      setEditForm(formForUser(updated));
      setMessage({ kind: "success", text: "Saved" });
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Unable to save user.";
      try {
        // A timed-out response or failed compensation can leave a provider
        // change persisted. Always display its actual state before another edit.
        const actual = await getManagedUser(selected.id);
        setSelected(actual);
        setEditForm(formForUser(actual));
        setUsers((current) => current.map((user) => user.id === actual.id ? actual : user));
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
    if (!selected?.canManage || !event.currentTarget.reportValidity()) return;
    if (!isPasswordValid(newPassword)) {
      setMessage({ kind: "error", text: PASSWORD_POLICY_MESSAGE });
      return;
    }
    if (!beginOperation("password")) return;
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
    if (!selected?.canManage || !beginOperation("sessions")) return;
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

  function openCreate() {
    if (pending.current || securityPending.current) return;
    setSelected(null);
    setCreateForm(emptyForm);
    setMessage(null);
    setShowCreate(true);
  }

  function closeCreate() {
    if (pending.current || securityPending.current) return;
    setShowCreate(false);
    setMessage(null);
  }

  function clearSearch() {
    if (pending.current || securityPending.current) return;
    setSearch("");
    setStateFilter("all");
    void load("");
  }

  const visibleUsers = useMemo(() => users.filter((user) => stateFilter === "all" || user.enabled === (stateFilter === "active")), [users, stateFilter]);
  const selectedName = selected ? userName(selected) : "";
  const hasChanges = selected?.canManage ? (
    editForm.firstName !== selected.firstName || editForm.lastName !== selected.lastName ||
    editForm.email !== selected.email || editForm.enabled !== selected.enabled ||
    (editForm.checkpointId ?? null) !== (selected.checkpointId ?? null) ||
    [...editForm.roles].sort().join(",") !== [...(selected.roles ?? [])].sort().join(",")
  ) : false;

  return (
    <main className={styles.page} aria-label="User management">
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1>Manage users</h1>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.unlockStatus} aria-label={`User management access expires in ${stepUpCountdown}`}>
            <ShieldCheck size={23} aria-hidden="true" />
            <time className={styles.countdown} aria-label={`Re-authentication expires in ${stepUpCountdown}`}>{stepUpCountdown}</time>
          </div>
          <button className={styles.iconActionButton} type="button" aria-label="New user" title="New user" disabled={busy} onClick={openCreate}>
            <Plus size={23} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className={styles.unlockBar} aria-label="User management access">
        <div className={styles.accessControls}>
          <StepUpDurationSelect value={durationMinutes} onChange={setDurationMinutes} disabled={busy} label="Duration" />
          <button className={styles.iconActionButton} type="button" aria-label="Extend access" title={securityAction === "extend" ? "Opening sign-in…" : "Extend access"} disabled={busy} onClick={() => void extend()}>
            <KeyRound size={18} aria-hidden="true" />
          </button>
          <button className={styles.iconActionButton} type="button" aria-label="Lock user management" title={securityAction === "lock" ? "Locking…" : "Lock user management"} disabled={busy} onClick={() => void lock()}>
            <LockKeyhole size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

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
                <h2 id="directory-title">Users</h2>
              </div>
            </div>
            <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); void load(); }}>
              <input aria-label="Search users" maxLength={100} value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder="Search users" />
              {search || appliedSearch ? (
                <button className={styles.clearButton} type="button" aria-label="Clear search" disabled={busy} onClick={clearSearch}>
                  <X size={17} aria-hidden="true" />
                </button>
              ) : null}
              <button className={styles.searchButton} type="submit" aria-label="Search users" title="Search" disabled={busy}><Search size={17} aria-hidden="true" /></button>
            </form>
            <div className={styles.filterRow}>
              <div className={styles.stateFilter} role="group" aria-label="Filter account status">
                {(["all", "active", "disabled"] as const).map((filter) => (
                  <button key={filter} type="button" aria-pressed={stateFilter === filter} disabled={busy} onClick={() => setStateFilter(filter)}>
                    {filter === "all" ? "All" : filter === "active" ? "Active" : "Disabled"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loadError ? (
            <div className={styles.emptyState} role="alert">
              <span className={styles.emptyIcon}><UsersRound size={26} aria-hidden="true" /></span>
              <h3>Unable to load management data</h3>
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

          <div className={`${styles.directoryGrid} scrollable-content`}>
            {visibleUsers.map((user) => {
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
                            {user.roles.length ? user.roles.map((role) => (
                              <span key={role} className={styles.roleBadge} data-role={role}>{role === "admin" ? "Admin" : "Operator"}</span>
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
                        <MapPin size={16} aria-hidden="true" /><span>{checkpoint?.name ?? "Unassigned"}</span>
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
              <h3>{appliedSearch || stateFilter !== "all" ? "No matching users" : "No users yet"}</h3>
              {appliedSearch || stateFilter !== "all" ? <button className={styles.secondaryButton} type="button" aria-label="Clear filters" title="Clear filters" disabled={busy} onClick={clearSearch}><X size={18} aria-hidden="true" /></button> : <button className={styles.iconActionButton} type="button" aria-label="New user" title="New user" disabled={busy} onClick={openCreate}><Plus size={23} aria-hidden="true" /></button>}
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
                    <span className={styles.statusBadge} data-enabled={editForm.enabled}>{editForm.enabled ? "Active" : "Disabled"}</span>
                    {hasChanges ? <span className={styles.draftBadge} title="Unsaved changes">Unsaved</span> : null}
                  </div>
                </div>
                {selected.canManage ? <label className={styles.enabledToggle}>
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
              {selected.canManage ? <UserDetailsForm form={editForm} onChange={setEditForm} busy={busy} onSubmit={saveUser} checkpoints={checkpoints} /> : <p className={styles.statusMessage} role="status">This account has no manageable application role.</p>}
              {selected.canManage ? <section className={styles.securityPanel} aria-label="Security settings">
                <form className={styles.passwordForm} onSubmit={resetPassword}>
                  <label className={styles.field}>
                    Password
                    <input required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} type="password" autoComplete="new-password" disabled={busy} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="8+ characters" />
                  </label>
                  <PasswordRequirements value={newPassword} />
                  <label className={styles.checkRow}>
                    <input type="checkbox" checked={temporaryPassword} disabled={busy} onChange={(event) => setTemporaryPassword(event.target.checked)} />
                    <span>Change at sign-in</span>
                  </label>
                  <div className={styles.securityActionRow}>
                    <button className={styles.dangerButton} type="button" aria-label="End sessions" title={operation === "sessions" ? "Ending sessions…" : "End sessions"} disabled={busy} onClick={() => void endSessions()}>
                      End sessions
                    </button>
                    <button className={styles.secondaryButton} type="submit" aria-label="Reset password" title={operation === "password" ? "Resetting…" : "Reset password"} disabled={busy || !isPasswordValid(newPassword)}>
                      Reset password
                    </button>
                  </div>
                </form>
              </section> : null}
            </div>
          </section>
        ) : null}
      </div>

      {showCreate ? (
        <dialog ref={dialogRef} className={styles.createDialog} aria-labelledby="create-user-title" onCancel={(event) => { event.preventDefault(); closeCreate(); }}>
          <div className={styles.dialogHeader}>
            <span className={styles.dialogIcon}><UserRound size={25} aria-hidden="true" /></span>
            <div><h2 id="create-user-title">Create user</h2></div>
            <button className={styles.closeButton} type="button" aria-label="Close create user" disabled={busy} onClick={closeCreate}>
              <X size={22} aria-hidden="true" />
            </button>
          </div>
          <div className={`${styles.dialogBody} scrollable-content`}>
            {message ? (
              <p className={styles.formMessage} data-kind={message.kind} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>
            ) : null}
            <CreateUserForm form={createForm} onChange={setCreateForm} busy={busy} onSubmit={create} onCancel={closeCreate} checkpoints={checkpoints} />
          </div>
        </dialog>
      ) : null}
    </main>
  );
}
