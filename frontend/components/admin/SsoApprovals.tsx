"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, LoaderCircle, RefreshCw, Search, ShieldCheck, UserRound } from "lucide-react";
import type { Checkpoint, OrganizationZone } from "../../../lib/types";
import { checkpointDisplayName } from "../../../lib/facilityZones";
import {
  approveZohoSsoUser,
  listPendingZohoSsoUsers,
  type PendingSsoUser,
  type PendingSsoUserPage,
} from "../../../services/keycloakUserService";
import { listCheckpoints } from "../../../services/checkpointService";
import { listZones } from "../../../services/zoneService";
import styles from "./SsoApprovals.module.css";

type RoleChoice = "" | "operator" | "zone-admin";

function displayName(user: PendingSsoUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.username || user.email || "Zoho user";
}

function formatCreatedAt(timestamp?: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : `Account created ${date.toLocaleDateString()}`;
}

export function SsoApprovals() {
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [referencesError, setReferencesError] = useState("");
  const [items, setItems] = useState<PendingSsoUser[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState<PendingSsoUserPage | null>(null);
  const [role, setRole] = useState<RoleChoice>("");
  const [checkpointId, setCheckpointId] = useState("");
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const activeZones = useMemo(() => zones.filter((zone) => zone.active), [zones]);
  const activeCheckpoints = useMemo(() => checkpoints.filter((checkpoint) => checkpoint.active !== false), [checkpoints]);

  useEffect(() => {
    let current = true;
    setReferencesError("");
    void Promise.all([listZones(), listCheckpoints()]).then(([zoneRows, checkpointRows]) => {
      if (!current) return;
      setZones(zoneRows);
      setCheckpoints(checkpointRows);
    }).catch((cause: unknown) => {
      if (current) setReferencesError(cause instanceof Error ? cause.message : "Could not load zones and checkpoints.");
    });
    return () => { current = false; };
  }, [refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNotice("");
    setItems([]);
    setPage(null);
    setSelectedId("");
    setRole("");
    setCheckpointId("");
    setZoneIds([]);
    void listPendingZohoSsoUsers(appliedSearch, 0, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setItems(result.items);
      setPage(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load pending Zoho accounts.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [appliedSearch, refreshKey]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedSearch(search.trim());
  }

  function selectUser(user: PendingSsoUser) {
    setSelectedId(user.id);
    setRole("");
    setCheckpointId("");
    setZoneIds([]);
    setError("");
    setNotice("");
  }

  async function loadMore() {
    if (!page?.hasMore || page.nextFirst === null || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const next = await listPendingZohoSsoUsers(appliedSearch, page.nextFirst);
      setItems((previous) => {
        const known = new Set(previous.map((user) => user.id));
        return [...previous, ...next.items.filter((user) => !known.has(user.id))];
      });
      setPage(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more accounts.");
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleZone(zoneId: string) {
    setZoneIds((previous) => previous.includes(zoneId)
      ? previous.filter((id) => id !== zoneId)
      : [...previous, zoneId]);
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || (role !== "operator" && role !== "zone-admin")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await approveZohoSsoUser(selected.id, {
        roles: [role],
        ...(role === "operator" ? { checkpointId } : { zoneIds }),
      });
      const approvedName = displayName(selected);
      setItems((previous) => previous.filter((user) => user.id !== selected.id));
      setSelectedId("");
      setRole("");
      setCheckpointId("");
      setZoneIds([]);
      setNotice(`${approvedName} can now sign out and sign in again through Zoho to use In / Out.`);
      try {
        const refreshed = await listPendingZohoSsoUsers(appliedSearch, 0);
        setItems(refreshed.items);
        setPage(refreshed);
      } catch {
        setError("Access was approved, but the queue could not refresh. Use Retry to reload it.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve this Zoho account.");
    } finally {
      setSaving(false);
    }
  }

  const canApprove = !!selected && !saving && !referencesError && (
    role === "operator" ? activeCheckpoints.some((checkpoint) => checkpoint.id === checkpointId) :
    role === "zone-admin" ? zoneIds.some((zoneId) => activeZones.some((zone) => zone.id === zoneId)) : false
  );

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1>SSO approvals</h1>
          <p className={styles.intro}>No invitation is needed. Review first-time Zoho sign-ins and assign each person an In / Out role and operating area.</p>
        </div>
        <div className={styles.counter} aria-live="polite"><strong>{page?.items.length ?? items.length}</strong><span>waiting on this page</span></div>
      </header>

      {notice ? <div className={styles.notice} role="status"><Check size={18} aria-hidden="true" />{notice}</div> : null}
      {error ? <div className={styles.error} role="alert">{error}<button type="button" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Retry</button></div> : null}

      <section className={styles.workspace} aria-label="First-time Zoho access requests">
        <div className={styles.queue}>
          <div className={styles.queueHeader}>
            <div><h2>Pending accounts</h2><span>Zoho linked · no In / Out role</span></div>
            <button className={styles.refreshButton} type="button" aria-label="Refresh pending Zoho accounts" title="Refresh" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={17} aria-hidden="true" /></button>
          </div>
          <form className={styles.search} onSubmit={submitSearch} role="search">
            <Search size={17} aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, username or email" aria-label="Search pending accounts" />
            <button type="submit">Search</button>
          </form>
          <div className={styles.userList} aria-busy={loading}>
            {loading ? <div className={styles.empty}><LoaderCircle className={styles.spinner} size={21} aria-hidden="true" />Loading accounts…</div> : null}
            {!loading && items.length === 0 ? <div className={styles.empty}><UserRound size={21} aria-hidden="true" /><strong>No pending accounts</strong><span>People who sign in through Zoho without an invitation will appear here until assigned an In / Out role.</span></div> : null}
            {!loading && items.map((user) => (
              <button key={user.id} type="button" className={styles.userRow} data-selected={user.id === selectedId} onClick={() => selectUser(user)}>
                <span className={styles.avatar} aria-hidden="true">{displayName(user).slice(0, 1).toUpperCase()}</span>
                <span className={styles.userCopy}><strong>{displayName(user)}</strong><span>{user.email || `@${user.username}`}</span><small>{formatCreatedAt(user.createdTimestamp)}</small></span>
                <span className={styles.pendingTag}>Pending</span>
              </button>
            ))}
          </div>
          {page?.hasMore ? <button className={styles.loadMore} type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" /> : null}{loadingMore ? "Loading…" : "Load more accounts"}</button> : null}
        </div>

        <div className={styles.review}>
          {!selected ? (
            <div className={styles.reviewEmpty}><div className={styles.reviewIcon}><ShieldCheck size={22} aria-hidden="true" /></div><h2>Select an account</h2><p>Choose a pending Zoho account to review its details and assign access.</p></div>
          ) : (
            <>
              <div className={styles.identity}>
                <span className={styles.avatarLarge} aria-hidden="true">{displayName(selected).slice(0, 1).toUpperCase()}</span>
                <div><p className={styles.eyebrow}>ZOHO ACCOUNT</p><h2>{displayName(selected)}</h2><p>{selected.email || `@${selected.username}`}</p></div>
              </div>
              <form className={styles.approvalForm} onSubmit={(event) => void approve(event)}>
                <fieldset className={styles.fieldset} disabled={saving}>
                  <legend>Assign application role</legend>
                  <div className={styles.roleOptions}>
                    <label className={styles.roleOption} data-selected={role === "operator"}>
                      <input type="radio" name="assigned-role" value="operator" checked={role === "operator"} onChange={() => { setRole("operator"); setZoneIds([]); }} />
                      <span><strong>Operator</strong><small>Can use the terminal at one assigned checkpoint.</small></span>
                    </label>
                    <label className={styles.roleOption} data-selected={role === "zone-admin"}>
                      <input type="radio" name="assigned-role" value="zone-admin" checked={role === "zone-admin"} onChange={() => { setRole("zone-admin"); setCheckpointId(""); }} />
                      <span><strong>Zone admin</strong><small>Can manage users and access within assigned zones.</small></span>
                    </label>
                  </div>

                  {role === "operator" ? <label className={styles.field}><span>Checkpoint</span><select required value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}><option value="">Select a checkpoint</option>{activeCheckpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{zones.find((zone) => zone.id === (checkpoint.zoneId ?? checkpoint.zone))?.name ?? checkpoint.zoneName ?? "Zone"} · {checkpointDisplayName(checkpoint, zones)}</option>)}</select>{activeCheckpoints.length === 0 ? <small>Create an active checkpoint before approving an operator.</small> : null}</label> : null}

                  {role === "zone-admin" ? <fieldset className={styles.zoneFieldset}>
                    <legend>Zones this admin can manage</legend>
                    {activeZones.length ? <div className={styles.zoneOptions}>{activeZones.map((zone) => <label key={zone.id} className={styles.zoneOption}><input type="checkbox" checked={zoneIds.includes(zone.id)} onChange={() => toggleZone(zone.id)} /><span>{zone.name}</span></label>)}</div> : <p className={styles.helper}>Create an active zone before approving a zone admin.</p>}
                    <small>Select one or more zones.</small>
                  </fieldset> : null}

                  {referencesError ? <p className={styles.errorInline} role="alert">{referencesError}</p> : null}
                  <div className={styles.securityNote}><ShieldCheck size={17} aria-hidden="true" /><span>Only this account receives the selected role. Master-admin access cannot be assigned here.</span></div>
                </fieldset>
                <div className={styles.formFooter}>
                  <span>Approval is recorded in the audit log.</span>
                  <button className={styles.approveButton} type="submit" disabled={!canApprove}>{saving ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}{saving ? "Approving…" : "Approve access"}</button>
                </div>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
