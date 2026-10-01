"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, LockKeyhole, Plus, Power, Search, ShieldCheck, X } from "lucide-react";
import { createManagedUser, endManagedUserSessions, listManagedUsers, resetManagedUserPassword, setManagedUserRoles, updateManagedUser, type ManagedUser } from "../../../services/keycloakUserService";

type UserForm = { username: string; firstName: string; lastName: string; email: string; password: string; temporaryPassword: boolean; enabled: boolean; roles: Array<"admin" | "operator"> };
const emptyForm: UserForm = { username: "", firstName: "", lastName: "", email: "", password: "", temporaryPassword: true, enabled: true, roles: [] };

function Roles({ value, onChange }: { value: Array<"admin" | "operator">; onChange: (roles: Array<"admin" | "operator">) => void }) {
  return <div className="identity-role-options" aria-label="Application roles">{(["admin", "operator"] as const).map((role) => <label key={role}><input type="checkbox" checked={value.includes(role)} onChange={(event) => onChange(event.target.checked ? [...value, role] : value.filter((item) => item !== role))} /> {role}</label>)}</div>;
}

export function UserManagement({ stepUpExpiresAt }: { stepUpExpiresAt: number }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<UserForm>(emptyForm);
  const [editForm, setEditForm] = useState<UserForm>(emptyForm);
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(interval); }, []);
  const stepUpSecondsRemaining = Math.max(0, Math.ceil(stepUpExpiresAt - now / 1_000));
  const stepUpCountdown = `${Math.floor(stepUpSecondsRemaining / 60)}:${String(stepUpSecondsRemaining % 60).padStart(2, "0")}`;
  useEffect(() => { if (stepUpSecondsRemaining === 0) window.location.assign("/admin/users"); }, [stepUpSecondsRemaining]);

  async function load(query = search) {
    setBusy(true);
    try { const result = await listManagedUsers(query); setUsers(result.items); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load Keycloak users."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(""); }, []);

  const selectedName = useMemo(() => selected ? [selected.firstName, selected.lastName].filter(Boolean).join(" ") || selected.username : "", [selected]);
  function choose(user: ManagedUser) {
    setSelected(user);
    setEditForm({ username: user.username, firstName: user.firstName, lastName: user.lastName, email: user.email, password: "", temporaryPassword: true, enabled: user.enabled, roles: user.roles ?? [] });
    setNewPassword(""); setMessage("");
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const created = await createManagedUser(createForm); setUsers((current) => [created, ...current]); setCreateForm(emptyForm); setShowCreate(false); choose(created); setMessage("User created in Keycloak."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to create user."); }
    finally { setBusy(false); }
  }
  async function saveUser() {
    if (!selected) return; setBusy(true);
    try { const updated = await updateManagedUser(selected.id, { firstName: editForm.firstName, lastName: editForm.lastName, email: editForm.email, enabled: editForm.enabled }); await setManagedUserRoles(selected.id, editForm.roles); const complete = { ...updated, roles: editForm.roles }; setUsers((current) => current.map((user) => user.id === selected.id ? complete : user)); setSelected(complete); setMessage("User details and roles saved."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save user."); }
    finally { setBusy(false); }
  }
  async function resetPassword() {
    if (!selected || !newPassword) return; setBusy(true);
    try { await resetManagedUserPassword(selected.id, newPassword, editForm.temporaryPassword); setNewPassword(""); setMessage("Password reset saved. The user will be prompted to change it if temporary."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to reset password."); }
    finally { setBusy(false); }
  }
  async function endSessions() {
    if (!selected) return; setBusy(true);
    try { await endManagedUserSessions(selected.id); setMessage("All active sessions for this user were ended."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to end sessions."); }
    finally { setBusy(false); }
  }
  async function lock() {
    await fetch("/api/auth/step-up", { method: "DELETE", cache: "no-store" });
    window.location.assign("/admin/users");
  }

  return <main className="identity-workspace identity-workspace-flat" aria-label="Keycloak user management">
    <header className="identity-header identity-header-flat"><div><span className="eyebrow">Identity</span><h1>Manage users</h1><p>Create users, control application roles, and end compromised sessions without leaving InOut.</p></div><div className="identity-header-actions"><div className="identity-step-up-timer" role="status" aria-live="polite"><ShieldCheck aria-hidden="true" /><span>Re-authentication active</span><strong>{stepUpCountdown}</strong></div><button className="admin-button admin-button--ghost ghost-button identity-lock-button" type="button" onClick={() => void lock()}><LockKeyhole aria-hidden="true" /> Lock</button><button className="admin-button admin-button--primary primary-button" type="button" onClick={() => { setShowCreate(true); setSelected(null); }}><Plus aria-hidden="true" /> New user</button></div></header>
    {message ? <p className="identity-status" role="status">{message}</p> : null}

    {showCreate ? <section className="identity-create-pane" aria-labelledby="create-user-title"><div className="identity-section-heading"><div><span className="eyebrow">New account</span><h2 id="create-user-title">Create a Keycloak user</h2></div><button className="admin-button admin-button--icon icon-button" type="button" aria-label="Close create user" onClick={() => setShowCreate(false)}><X aria-hidden="true" /></button></div><form className="identity-create-form" onSubmit={create}><label>First name<input value={createForm.firstName} onChange={(e) => setCreateForm({ ...createForm, firstName: e.target.value })} /></label><label>Last name<input value={createForm.lastName} onChange={(e) => setCreateForm({ ...createForm, lastName: e.target.value })} /></label><label>Nickname<input required minLength={3} autoComplete="username" value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} /></label><label>Email<input type="email" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} /></label><label>Password<input required type="password" minLength={12} value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} /></label><div className="identity-create-roles"><span>Roles</span><Roles value={createForm.roles} onChange={(roles) => setCreateForm({ ...createForm, roles })} /></div><label className="identity-check"><input type="checkbox" checked={createForm.temporaryPassword} onChange={(e) => setCreateForm({ ...createForm, temporaryPassword: e.target.checked })} /> Require password change on first sign-in</label><button className="admin-button admin-button--primary primary-button" disabled={busy} type="submit">Create user</button></form></section> : null}

    <section className="identity-directory-workspace" aria-labelledby="directory-title"><div className="identity-directory-toolbar"><div><span className="eyebrow">Directory</span><h2 id="directory-title">Users</h2></div><form className="identity-search" onSubmit={(e) => { e.preventDefault(); void load(); }}><Search aria-hidden="true" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, or username" /><button type="submit" disabled={busy}>Search</button></form></div><div className="identity-table-scroll"><table className="identity-user-table"><thead><tr><th>Name</th><th>Username</th><th>Roles</th><th>Status</th></tr></thead><tbody>{users.map((user) => <tr key={user.id} className={selected?.id === user.id ? "selected" : ""}><td><button type="button" onClick={() => choose(user)}>{[user.firstName, user.lastName].filter(Boolean).join(" ") || user.username}</button></td><td>@{user.username}<small>{user.email || "No email address"}</small></td><td>{user.roles?.length ? user.roles.join(", ") : "No app role"}</td><td><span className={`identity-status-pill ${user.enabled ? "is-active" : "is-disabled"}`}>{user.enabled ? "Active" : "Disabled"}</span></td></tr>)}</tbody></table>{!busy && !users.length ? <p className="inline-note">No matching users.</p> : null}</div></section>

    {selected ? <section className="identity-editor-workspace" aria-labelledby="edit-user-title"><div className="identity-section-heading"><div><span className="eyebrow">Selected user</span><h2 id="edit-user-title">{selectedName}</h2><p>@{selected.username}</p></div><button className="admin-button admin-button--ghost ghost-button" type="button" onClick={() => setSelected(null)}>Close</button></div><div className="identity-editor-grid"><div className="identity-form identity-user-fields"><div className="identity-two-column"><label>First name<input value={editForm.firstName} onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })} /></label><label>Last name<input value={editForm.lastName} onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })} /></label></div><label>Email<input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></label><Roles value={editForm.roles} onChange={(roles) => setEditForm({ ...editForm, roles })} /><label className="identity-check"><input type="checkbox" checked={editForm.enabled} onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })} /> <Power size={15} aria-hidden="true" /> Account enabled</label><button type="button" className="admin-button admin-button--secondary secondary-button" onClick={() => void saveUser()} disabled={busy}>Save changes</button></div><div className="identity-security-actions"><div><KeyRound aria-hidden="true" /><h3>Reset password</h3><p>Set a new password for this account.</p></div><label>New password<input type="password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 12 characters" /></label><button type="button" onClick={() => void resetPassword()} disabled={busy || newPassword.length < 12}>Reset password</button><button type="button" className="admin-button admin-button--ghost ghost-button" onClick={() => void endSessions()} disabled={busy}>End all active sessions</button></div></div></section> : null}
  </main>;
}
