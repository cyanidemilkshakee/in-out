"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BadgeCheck, Building2, Check, ChevronDown, LoaderCircle, Mail, MapPin, RotateCw, Search, ShieldCheck, UserRound, X } from "lucide-react";
import type { Checkpoint, OrganizationZone } from "../../../lib/types";
import { listCheckpoints } from "../../../services/checkpointService";
import { listZones } from "../../../services/zoneService";
import styles from "./ZohoSignInApprovals.module.css";

type PendingZohoUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
};

type PendingPage = {
  items: PendingZohoUser[];
  first: number;
  max: number;
  hasMore: boolean;
  nextFirst: number | null;
};

type ApplicationRole = "operator" | "zone-admin";
const PAGE_SIZE = 25;

function displayName(user: PendingZohoUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;
}

function initials(user: PendingZohoUser) {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return (parts.length ? parts.map((part) => part[0]).join("") : user.username.slice(0, 2)).toUpperCase();
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

async function fetchPending(search: string, first: number, signal?: AbortSignal): Promise<PendingPage> {
  const query = new URLSearchParams({ search, first: String(first), max: String(PAGE_SIZE) });
  const response = await fetch(`/api/zoho-approvals?${query}`, { cache: "no-store", signal });
  const payload = await response.json().catch(() => null) as { data?: PendingPage; error?: string } | null;
  if (!response.ok || !payload?.data || !Array.isArray(payload.data.items)) {
    throw new Error(payload?.error ?? "Unable to load Zoho sign-in requests.");
  }
  return payload.data;
}

export function ZohoSignInApprovals() {
  const [users, setUsers] = useState<PendingZohoUser[]>([]);
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [nextFirst, setNextFirst] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<ApplicationRole>("operator");
  const [checkpointId, setCheckpointId] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [error, setError] = useState("");
  const [referenceError, setReferenceError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const requestVersion = useRef(0);
  const loadMoreVersion = useRef(0);

  const selected = users.find((user) => user.id === selectedId) ?? null;
  const activeZones = useMemo(() => zones.filter((zone) => zone.active), [zones]);
  const activeCheckpoints = useMemo(() => checkpoints.filter((checkpoint) => checkpoint.active !== false), [checkpoints]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    loadMoreVersion.current++;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    try {
      const page = await fetchPending(appliedSearch, 0, signal);
      if (!signal?.aborted && version === requestVersion.current) {
        setUsers(page.items);
        setNextFirst(page.nextFirst);
        setSelectedId((current) => page.items.some((user) => user.id === current) ? current : null);
      }
    } catch (loadError) {
      if (!signal?.aborted && version === requestVersion.current) setError(messageFrom(loadError));
    } finally {
      if (!signal?.aborted && version === requestVersion.current) setLoading(false);
    }
  }, [appliedSearch]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload, refreshKey]);

  useEffect(() => {
    let active = true;
    setReferenceLoading(true);
    setReferenceError("");
    void Promise.all([listZones(), listCheckpoints()]).then(([zoneRows, checkpointRows]) => {
      if (active) {
        setZones(zoneRows);
        setCheckpoints(checkpointRows);
      }
    }).catch((loadError: unknown) => {
      if (active) setReferenceError(messageFrom(loadError));
    }).finally(() => {
      if (active) setReferenceLoading(false);
    });
    return () => { active = false; };
  }, []);

  function selectUser(user: PendingZohoUser) {
    setSelectedId(user.id);
    setRole("operator");
    setCheckpointId("");
    setZoneIds([]);
    setMessage("");
    setError("");
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestVersion.current++;
    loadMoreVersion.current++;
    setLoadingMore(false);
    setSelectedId(null);
    setAppliedSearch(search.trim());
  }

  async function loadMore() {
    if (nextFirst === null || loadingMore) return;
    const version = requestVersion.current;
    const loadVersion = ++loadMoreVersion.current;
    setLoadingMore(true);
    setError("");
    try {
      const page = await fetchPending(appliedSearch, nextFirst);
      if (version !== requestVersion.current || loadVersion !== loadMoreVersion.current) return;
      setUsers((current) => {
        const known = new Set(current.map((user) => user.id));
        return [...current, ...page.items.filter((user) => !known.has(user.id))];
      });
      setNextFirst(page.nextFirst);
    } catch (loadError) {
      if (version === requestVersion.current && loadVersion === loadMoreVersion.current) setError(messageFrom(loadError));
    } finally {
      if (loadVersion === loadMoreVersion.current) setLoadingMore(false);
    }
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving) return;
    if (role === "operator" && !checkpointId) {
      setError("Choose the checkpoint this operator will use.");
      return;
    }
    if (role === "zone-admin" && zoneIds.length === 0) {
      setError("Choose at least one zone for this zone admin.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    requestVersion.current++;
    loadMoreVersion.current++;
    setLoadingMore(false);
    try {
      const input = role === "operator"
        ? { userId: selected.id, role, checkpointId, zoneIds: [] }
        : { userId: selected.id, role, checkpointId: null, zoneIds };
      const response = await fetch("/api/zoho-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await response.json().catch(() => null) as { data?: unknown; error?: string } | null;
      if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "Approval could not be completed.");
      setUsers((current) => current.filter((user) => user.id !== selected.id));
      setSelectedId(null);
      setMessage(`${displayName(selected)} now has ${role === "operator" ? "operator" : "zone admin"} access.`);
      setRefreshKey((current) => current + 1);
    } catch (approvalError) {
      setError(messageFrom(approvalError));
      // Approval may have succeeded before an existing session failed to end.
      // Refresh the queue so the page reflects the authoritative Keycloak role.
      setRefreshKey((current) => current + 1);
    } finally {
      setSaving(false);
    }
  }

  const checkpointLabel = (checkpoint: Checkpoint) => {
    const zone = checkpoint.zoneName || zones.find((item) => item.id === checkpoint.zoneId)?.name || checkpoint.zone;
    return `${zone} · ${checkpoint.gateLabel || checkpoint.name}`;
  };

  return <main className={styles.page} aria-label="Zoho sign-in approvals">
    <header className={styles.header}>
      <div>
        <div className={styles.eyebrow}><ShieldCheck size={16} aria-hidden="true" /> Identity review</div>
        <h1>Zoho sign-in approvals</h1>
        <p>Review accounts linked through Zoho that do not yet have InOut access. Choose an application role and its required access scope to approve an account.</p>
      </div>
      <button className={styles.refreshButton} type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading || loadingMore}>
        <RotateCw size={17} aria-hidden="true" /> Refresh
      </button>
    </header>

    {message ? <p className={styles.success} role="status"><Check size={17} aria-hidden="true" />{message}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {referenceError ? <p className={styles.error} role="alert">Unable to load zones and checkpoints: {referenceError}</p> : null}

    <div className={styles.workspace}>
      <section className={styles.directory} aria-labelledby="pending-title">
        <header className={styles.directoryHeader}>
          <div className={styles.directoryHeading}>
            <div><h2 id="pending-title">Pending accounts</h2><p>Zoho-linked identities without an InOut application role</p></div>
            <span className={styles.count} aria-label={`${users.length} accounts shown`}>{users.length}</span>
          </div>
          <form className={styles.search} role="search" onSubmit={submitSearch}>
            <Search size={17} aria-hidden="true" />
            <input aria-label="Search pending accounts" placeholder="Name, username, or email" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} />
            <button type="submit" aria-label="Search"><Search size={16} aria-hidden="true" /></button>
          </form>
        </header>
        <div className={styles.userList} aria-live="polite" aria-busy={loading}>
          {loading ? <p className={styles.loading}><LoaderCircle className={styles.spinner} size={19} aria-hidden="true" /> Checking linked accounts…</p> : null}
          {!loading && users.length === 0 && !error ? <div className={styles.empty}>
            <span><BadgeCheck size={24} aria-hidden="true" /></span>
            <h3>{appliedSearch ? nextFirst !== null ? "No matches in this batch" : "No matching pending accounts" : nextFirst !== null ? "No pending accounts in this batch" : "No accounts need approval"}</h3>
            <p>{appliedSearch
              ? nextFirst !== null ? "There are more identity accounts to search. Load the next batch to continue."
                : "Try another name, username, or email."
              : nextFirst !== null ? "There are more identity accounts to check. Load the next batch to continue reviewing."
                : "New Zoho-linked users will appear here after their first sign-in, until an InOut role is assigned."}</p>
          </div> : null}
          {!loading ? users.map((user) => <article className={styles.userRow} key={user.id} data-selected={selectedId === user.id}>
            <span className={styles.avatar} aria-hidden="true">{initials(user)}</span>
            <div className={styles.identity}>
              <h3>{displayName(user)}</h3>
              <p>@{user.username}</p>
              {user.email ? <p className={styles.email}><Mail size={14} aria-hidden="true" />{user.email}</p> : <p className={styles.missingEmail}>No email provided by Zoho</p>}
              <div className={styles.badges}>
                <span className={styles.providerBadge}>Zoho linked</span>
                <span className={styles.verificationBadge} data-verified={user.emailVerified}>{user.emailVerified ? "Email verified" : "Email not verified"}</span>
                {!user.enabled ? <span className={styles.disabledBadge}>Disabled</span> : null}
              </div>
            </div>
            <button className={styles.reviewButton} type="button" aria-pressed={selectedId === user.id} disabled={saving} onClick={() => selectedId === user.id ? setSelectedId(null) : selectUser(user)}>
              {selectedId === user.id ? <X size={16} aria-hidden="true" /> : <UserRound size={16} aria-hidden="true" />}
              {selectedId === user.id ? "Close" : "Review"}
            </button>
          </article>) : null}
        </div>
        {nextFirst !== null && !loading ? <button className={styles.loadMore} type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
          {loadingMore ? "Loading more…" : "Load more accounts"}
        </button> : null}
      </section>

      <aside className={styles.reviewPanel} aria-labelledby="review-title">
        {selected ? <>
          <header className={styles.reviewHeader}>
            <span className={styles.reviewIcon}><UserRound size={21} aria-hidden="true" /></span>
            <div><span className={styles.eyebrow}>Selected account</span><h2 id="review-title">{displayName(selected)}</h2><p>@{selected.username}</p></div>
          </header>
          <div className={styles.accountDetails}>
            <span><Mail size={15} aria-hidden="true" />{selected.email || "No email provided"}</span>
            <span><Building2 size={15} aria-hidden="true" />Identity provider: Zoho</span>
          </div>
          {!selected.enabled ? <p className={styles.disabledNotice} role="status">This Keycloak account is disabled. Approving it will enable the account.</p> : null}
          <form className={styles.approvalForm} onSubmit={approve}>
            <label className={styles.field}>
              InOut application role
              <select value={role} disabled={saving} onChange={(event) => { setRole(event.target.value as ApplicationRole); setError(""); }}>
                <option value="operator">Operator</option>
                <option value="zone-admin">Zone admin</option>
              </select>
            </label>
            {role === "operator" ? <label className={styles.field}>
              Assign checkpoint
              <select required value={checkpointId} disabled={saving || referenceLoading} onChange={(event) => setCheckpointId(event.target.value)}>
                <option value="">Choose a checkpoint</option>
                {activeCheckpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpointLabel(checkpoint)}</option>)}
              </select>
              <small>The operator will be assigned to scan at this checkpoint.</small>
            </label> : <fieldset className={styles.zoneFieldset} disabled={saving || referenceLoading}>
              <legend>Assign zone access</legend>
              <p>Choose every zone this zone admin will manage.</p>
              {activeZones.length ? activeZones.map((zone) => <label className={styles.zoneOption} key={zone.id}>
                <input type="checkbox" checked={zoneIds.includes(zone.id)} onChange={(event) => setZoneIds((current) => event.target.checked ? [...current, zone.id] : current.filter((id) => id !== zone.id))} />
                <span><MapPin size={16} aria-hidden="true" /><strong>{zone.name}</strong><small>{zone.checkpoints.length} {zone.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}</small></span>
              </label>) : <p className={styles.noZones}>No active zones are available. Create a zone before approving a zone admin.</p>}
            </fieldset>}
            {referenceLoading ? <p className={styles.referenceLoading}><LoaderCircle className={styles.spinner} size={16} aria-hidden="true" /> Loading access scopes…</p> : null}
            {!referenceLoading && role === "operator" && activeCheckpoints.length === 0 ? <p className={styles.noZones}>No active checkpoints are available. Create a checkpoint before approving an operator.</p> : null}
            <div className={styles.securityNote}><ShieldCheck size={17} aria-hidden="true" /><span>Approval grants app access only after the selected checkpoint or zone assignment is saved.</span></div>
            <footer className={styles.formActions}>
              <button className={styles.cancelButton} type="button" disabled={saving} onClick={() => setSelectedId(null)}>Cancel</button>
              <button className={styles.approveButton} type="submit" disabled={saving || referenceLoading || (role === "operator" ? !checkpointId || activeCheckpoints.length === 0 : !zoneIds.length || activeZones.length === 0)}>
                {saving ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
                {saving ? "Approving…" : "Approve account"}
              </button>
            </footer>
          </form>
        </> : <div className={styles.reviewEmpty}>
          <span><ShieldCheck size={26} aria-hidden="true" /></span>
          <h2 id="review-title">Review an account</h2>
          <p>Select a pending Zoho-linked identity, then assign its application role and access scope.</p>
        </div>}
      </aside>
    </div>
  </main>;
}
