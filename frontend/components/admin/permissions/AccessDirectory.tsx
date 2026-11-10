"use client";

import { useMemo, type ReactNode } from "react";
import { ChevronRight, Package, Search, ShieldAlert, SlidersHorizontal, UserRound, UsersRound, X } from "lucide-react";
import type { AccessPermission, Checkpoint, HardwareAsset } from "../../../../lib/types";
import { facilityZoneLabel } from "../../../../lib/facilityZones";
import { useAdminRole } from "../../../context/AdminRoleContext";
import { formatRequestDate, permissionDisplayState } from "./requestPresentation";
import styles from "./Requests.module.css";

type DirectoryTab = "people" | "hardware";

function entryAction(permission: AccessPermission) {
  return permission.state === "pending_approval" ? "Review permission" : "Manage";
}

export function AccessDirectory({ rows, hardwareAssets, checkpoints = [], tab, onTabChange, search, onSearchChange, stateFilter, onStateFilterChange, highlightedSubjectId, busy, isLoading, error, total, pagination, onReviewRequest, onManageAccess, onReassign }: {
  rows: AccessPermission[];
  hardwareAssets: HardwareAsset[];
  checkpoints?: Checkpoint[];
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
  pagination?: ReactNode;
  onReviewRequest: (permission: AccessPermission) => void;
  onManageAccess: (permission: AccessPermission) => void;
  onReassign: (permission: AccessPermission) => void;
}) {
  const { isMasterAdmin } = useAdminRole();
  const isZoneAdmin = !isMasterAdmin;
  const hardwareById = useMemo(() => new Map(hardwareAssets.map(asset => [asset.id, asset])), [hardwareAssets]);
  const checkpointsById = useMemo(() => new Map(checkpoints.map(checkpoint => [checkpoint.id, checkpoint])), [checkpoints]);
  return (
    <section className={styles.directoryPanel} aria-labelledby="directory-title">
      <div className={styles.directoryHeading}>
        <div className={styles.sectionTitle}><span className={styles.sectionIcon} aria-hidden="true"><UsersRound size={20} strokeWidth={1.7} /></span><div><h2 id="directory-title">Access directory</h2><p>Checkpoint access is grouped by zone.</p></div></div>
        <span className={styles.directoryCount} aria-label={`${total} matching permissions`}>{total}</span>
      </div>
      <div className={styles.directoryToolbar}>
      <div className={styles.directoryTabs} role="group" aria-label="Permission subject type">
        {(["people", "hardware"] as const).map((value) => {
          const label = value === "people" ? "People" : "Hardware";
          return <button key={value} type="button" aria-label={label} title={label} aria-pressed={tab === value} onClick={() => onTabChange(value)}>{value === "people" ? <UserRound size={18} aria-hidden="true" /> : <Package size={18} aria-hidden="true" />}</button>;
        })}
      </div>
      </div>
      <div className={styles.directoryFilters}>
        <div className={styles.directorySearch}><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder={`Find ${tab === "people" ? "a person" : "an asset"}…`} aria-label={`Search ${tab === "people" ? "people" : "hardware"} permissions`} />{search && <button type="button" aria-label="Clear search" onClick={() => onSearchChange("")}><X size={15} /></button>}</div>
        <label className={styles.stateFilter}><SlidersHorizontal size={16} aria-hidden="true" /><select value={stateFilter} onChange={(event) => onStateFilterChange(event.target.value)} aria-label="Access state"><option value="all">All states</option><option value="active">Active</option><option value="pending_approval">Pending approval</option><option value="restricted">Restricted</option><option value="revoked">Revoked</option><option value="expired">Expired</option></select></label>
      </div>
      <div className={`${styles.directoryList} scrollable-content`}>
        {isLoading && !total ? <p className={styles.directoryEmpty} role="status">Loading access permissions…</p> : error && !total ? <p className={styles.directoryEmpty}>Access permissions are unavailable. Use Retry above.</p> : !rows.length ? <div className={styles.directoryEmpty}><span className={styles.emptyIcon} aria-hidden="true"><Search size={24} strokeWidth={1.5} /></span><strong>{total ? "No matching permissions" : "Your directory starts here"}</strong><span>{total ? "Try another name, barcode, or access state." : "Registered subjects and granted permissions will appear here."}</span>{(search || stateFilter !== "all") && <button type="button" className={styles.contextLink} onClick={() => { onSearchChange(""); onStateFilterChange("all"); }}>Clear filters</button>}</div> : rows.map((permission) => {
          const effectiveCheckpointIds = permission.checkpoints?.length
            ? permission.checkpoints
            : checkpoints.filter((item) => item.active !== false && permission.zones?.includes(item.zoneId ?? item.zone)).map((item) => item.id);
          const checkpointNames = effectiveCheckpointIds.map((id) => {
            const item = checkpointsById.get(id);
            return { id, label: item?.gateLabel?.trim() || item?.name?.trim() || id };
          });
          const checkpointGroups = new Map<string, { zone: string; labels: Array<{ id: string; label: string }> }>();
          for (const checkpoint of checkpointNames) {
            const item = checkpointsById.get(checkpoint.id);
            const zoneId = item?.zoneId ?? item?.zone ?? permission.zones?.[0];
            const zone = zoneId ? item?.zoneName || facilityZoneLabel(zoneId) : "Unassigned";
            const group = checkpointGroups.get(zone) ?? { zone, labels: [] };
            group.labels.push(checkpoint);
            checkpointGroups.set(zone, group);
          }
          if (!checkpointGroups.size && permission.zones?.length) {
            for (const zoneId of permission.zones) {
              const zone = checkpoints.find((item) => (item.zoneId ?? item.zone) === zoneId)?.zoneName || facilityZoneLabel(zoneId);
              checkpointGroups.set(zone, { zone, labels: [{ id: zoneId, label: "All checkpoints" }] });
            }
          }
          const sortedCheckpointGroups = [...checkpointGroups.values()].sort((left, right) => left.zone.localeCompare(right.zone));
          const asset = hardwareById.get(permission.subjectId);
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
                    {(permission.barcode || asset?.barcode) && <span className={styles.subjectBarcode}>Barcode: {permission.barcode || asset?.barcode}</span>}
                    <span className={styles.subjectType}>{permission.subjectType === "employee" ? "Employee" : permission.subjectType === "visitor" ? "Visitor" : "Hardware"}</span>
                    <div className={styles.subjectScope} aria-label="Checkpoint access">
                      <span className={styles.scopeLabel}>Checkpoints</span>
                      {sortedCheckpointGroups.length
                        ? <div className={styles.scopeZoneGroups}>{sortedCheckpointGroups.map((group) => <div className={styles.scopeZoneGroup} key={group.zone}><strong>{group.zone}</strong><div className={styles.scopeTags}>{group.labels.map(({ id, label }) => <span className={styles.scopeTag} key={id}>{label}</span>)}</div></div>)}</div>
                        : <span className={styles.scopeEmpty}>{isZoneAdmin ? "No active checkpoints assigned" : "No checkpoints assigned"}</span>}
                    </div>
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
                <p>Restricted since {formatRequestDate(restriction.triggeredAt)}. Granting another permission does not lift this restriction. Review and lift it through Manage.</p>
              </div>}
              {permission.subjectType === "hardware" && <div className={styles.directoryActions}>
                <button type="button" disabled={busy || isLoading} className={styles.contextLink} onClick={() => onReassign(permission)}>Reassign custodian</button>
              </div>}
            </article>
          );
        })}
      </div>
      {pagination}
    </section>
  );
}
