"use client";

import { useRef, useState } from "react";
import { ChevronRight, Package, Search, ShieldAlert, ShieldCheck, SlidersHorizontal, UserRound, UsersRound, X } from "lucide-react";
import type { AccessPermission, HardwareAsset } from "../../../../lib/types";
import { formatFacilityZones } from "../../../../lib/facilityZones";
import { formatRequestDate, permissionDisplayState } from "./requestPresentation";
import styles from "./Requests.module.css";

type DirectoryTab = "people" | "hardware";

function entryAction(permission: AccessPermission) {
  return permission.state === "pending_approval" ? "Review permission" : "Manage";
}

export function AccessDirectory({ rows, hardwareAssets, tab, onTabChange, search, onSearchChange, stateFilter, onStateFilterChange, highlightedSubjectId, busy, isLoading, error, total, onReviewRequest, onManageAccess, onReassign, onReleaseRestriction }: {
  rows: AccessPermission[];
  hardwareAssets: HardwareAsset[];
  tab: DirectoryTab;
  onTabChange: (tab: DirectoryTab) => void;
  search: string;
  onSearchChange: (value: string) => void;
  stateFilter: string;
  onStateFilterChange: (value: string) => void;
  highlightedSubjectId: string;
  busy: boolean;
  isLoading: boolean;
  error: string | null;
  total: number;
  onReviewRequest: (permission: AccessPermission) => void;
  onManageAccess: (permission: AccessPermission) => void;
  onReassign: (permission: AccessPermission) => void;
  onReleaseRestriction: (permission: AccessPermission, reason: string) => void;
}) {
  const [releaseNotes, setReleaseNotes] = useState<Record<string, string>>({});
  const [invalidNotes, setInvalidNotes] = useState<Record<string, boolean>>({});
  const noteRefs = useRef<Record<string, HTMLInputElement | null>>({});

  function releaseRestriction(permission: AccessPermission) {
    const reason = releaseNotes[permission.id]?.trim();
    if (!reason) {
      setInvalidNotes((current) => ({ ...current, [permission.id]: true }));
      noteRefs.current[permission.id]?.focus();
      return;
    }
    onReleaseRestriction(permission, reason);
  }

  return (
    <section className={styles.directoryPanel} aria-labelledby="directory-title">
      <div className={styles.directoryHeading}>
        <div className={styles.sectionTitle}><span className={styles.sectionIcon} aria-hidden="true"><UsersRound size={20} strokeWidth={1.7} /></span><div><h2 id="directory-title">Access directory</h2><p>People and assets. Their zones and access windows.</p></div></div>
        <span className={styles.directoryCount} aria-label={`${rows.length} matching permissions`}>{rows.length}</span>
      </div>
      <div className={styles.directoryToolbar}>
      <div className={styles.directoryTabs} role="group" aria-label="Permission subject type">
        {(["people", "hardware"] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => onTabChange(value)}>{value === "people" ? <UserRound size={16} /> : <Package size={16} />}{value === "people" ? "People" : "Hardware"}</button>)}
      </div>
      <span className={styles.recordSummary}>{total} total permissions</span>
      </div>
      <div className={styles.directoryFilters}>
        <div className={styles.directorySearch}><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder={`Find ${tab === "people" ? "a person" : "an asset"}…`} aria-label={`Search ${tab === "people" ? "people" : "hardware"} permissions`} />{search && <button type="button" aria-label="Clear search" onClick={() => onSearchChange("")}><X size={15} /></button>}</div>
        <label className={styles.stateFilter}><SlidersHorizontal size={16} aria-hidden="true" /><select value={stateFilter} onChange={(event) => onStateFilterChange(event.target.value)} aria-label="Access state"><option value="all">All states</option><option value="active">Active</option><option value="pending_approval">Pending approval</option><option value="restricted">Restricted</option><option value="revoked">Revoked</option><option value="expired">Expired</option></select></label>
      </div>
      <div className={styles.directoryList}>
        {isLoading && !total ? <p className={styles.directoryEmpty} role="status">Loading access permissions…</p> : error && !total ? <p className={styles.directoryEmpty}>Access permissions are unavailable. Use Retry above.</p> : !rows.length ? <div className={styles.directoryEmpty}><span className={styles.emptyIcon} aria-hidden="true"><Search size={24} strokeWidth={1.5} /></span><strong>{total ? "No matching permissions" : "Your directory starts here"}</strong><span>{total ? "Try another name, barcode, or access state." : "Registered subjects and granted permissions will appear here."}</span>{(search || stateFilter !== "all") && <button type="button" className={styles.contextLink} onClick={() => { onSearchChange(""); onStateFilterChange("all"); }}>Clear filters</button>}</div> : rows.map((permission) => {
          const zones = formatFacilityZones(permission.zones) || "No zones assigned";
          const asset = hardwareAssets.find((item) => item.id === permission.subjectId);
          const action = entryAction(permission);
          const restriction = permission.entryRestriction?.active ? permission.entryRestriction : undefined;
          const displayState = permissionDisplayState(permission);
          return (
            <article id={`permission-${permission.subjectId}`} tabIndex={-1} key={permission.id} data-state={displayState} className={`${styles.directoryCard} ${highlightedSubjectId === permission.subjectId ? styles.selected : ""}`}>
              <header className={styles.directoryCardHeader}>
                <div className={styles.directoryIdentity}>
                  <span className={styles.subjectAvatar} data-type={permission.subjectType} aria-hidden="true">{permission.subjectType === "hardware" ? <Package size={20} strokeWidth={1.6} /> : permission.subjectName.split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
                  <div className={styles.directoryIdentityDetails}>
                    <div className={styles.directoryNameLine}><h3>{permission.subjectName}</h3><span className={styles.accessState} data-state={displayState}><span aria-hidden="true" />{displayState === "pending_approval" ? "Pending" : displayState.charAt(0).toUpperCase() + displayState.slice(1)}</span></div>
                    <span className={styles.subjectType}>{permission.subjectType === "employee" ? "Employee" : permission.subjectType === "visitor" ? "Visitor" : "Hardware"} · {zones}</span>
                  </div>
                </div>
                {action === "Review permission"
                  ? <button type="button" disabled={busy} data-action="grant" className={styles.entryAction} onClick={() => onReviewRequest(permission)}>Review permission<ChevronRight size={14} /></button>
                  : <button type="button" disabled={busy} data-action="grant" className={styles.entryAction} onClick={() => onManageAccess(permission)}>Manage<ChevronRight size={14} /></button>}
              </header>
              <div className={styles.directoryDetails}>
                {permission.subjectType === "hardware" && <p className={styles.directoryCustodian}><UserRound size={15} aria-hidden="true" /><span>Custodian · {asset?.assignedEmployeeName || "Unassigned"}</span></p>}
                <div className={styles.validWindow}><div><span>Access</span><strong>{permission.validFrom ? formatRequestDate(permission.validFrom) : "Immediately"}</strong></div><div><span>Expires</span><strong>{permission.validTo ? formatRequestDate(permission.validTo) : "No expiry"}</strong></div></div>
              </div>
              {restriction && <div className={styles.criticalRestriction}>
                <strong><ShieldAlert size={17} aria-hidden="true" />Entry restricted · administrator release required</strong>
                <p>Restricted since {formatRequestDate(restriction.triggeredAt)}. Granting another permission does not lift this restriction.</p>
                <label className={styles.releaseNote}><span>Reason to lift restriction</span><input ref={(node) => { noteRefs.current[permission.id] = node; }} type="text" value={releaseNotes[permission.id] ?? ""} disabled={busy} maxLength={1000} aria-label={`Reason to lift entry restriction for ${permission.subjectName}`} aria-invalid={Boolean(invalidNotes[permission.id])} onChange={(event) => { setReleaseNotes((current) => ({ ...current, [permission.id]: event.target.value })); if (event.target.value.trim()) setInvalidNotes((current) => ({ ...current, [permission.id]: false })); }} placeholder="Explain why entry can be restored." /></label>
                <button type="button" disabled={busy} className={styles.releaseAction} onClick={() => releaseRestriction(permission)}><ShieldCheck size={16} />Lift entry restriction</button>
              </div>}
              {permission.subjectType === "hardware" && <div className={styles.directoryActions}>
                <button type="button" disabled={busy} className={styles.contextLink} onClick={() => onReassign(permission)}>Reassign custodian</button>
              </div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
