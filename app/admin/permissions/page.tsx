"use client";

import { useMemo, useState } from "react";
import {
  BellRing,
  CalendarClock,
  Check,
  ChevronRight,
  KeyRound,
  Package,
  Search,
  ShieldBan,
  UsersRound,
  X,
} from "lucide-react";
import { useDataActions, useDataState } from "../../../context/DataContext";
import type { AccessPermission, PermissionRequest } from "../../../lib/types";

type DirectoryTab = "employee" | "visitor" | "hardware";

const TAB_LABELS: Array<{ id: DirectoryTab; label: string }> = [
  { id: "employee", label: "People" },
  { id: "visitor", label: "Visitors" },
  { id: "hardware", label: "Hardware" },
];

function permissionAction(permission: AccessPermission) {
  if (permission.state === "pending_approval") return "Review request";
  if (permission.subjectType === "hardware") {
    return permission.state === "active" ? "Restrict hardware" : "Allow hardware";
  }
  if (permission.subjectType === "employee") {
    return permission.state === "active" ? "Deny entry" : "Restore access";
  }
  return permission.state === "active" ? "Remove permission" : "Assign permission";
}

function requestLabel(request: PermissionRequest) {
  return request.type === "visitor" ? "Visitor request" : "Hardware custody request";
}

function formatLocalInput(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export default function PermissionManagerPage() {
  const {
    permissions,
    permissionRequests,
    notifications,
  } = useDataState();
  const {
    updateAccessPermission,
    decidePermissionRequest,
    markNotificationRead,
  } = useDataActions();
  const [tab, setTab] = useState<DirectoryTab>("employee");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [zones, setZones] = useState("Main Entrance");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [formError, setFormError] = useState("");
  const [feedback, setFeedback] = useState("");

  const pendingRequests = useMemo(
    () => permissionRequests.filter((request) => request.status === "pending"),
    [permissionRequests]
  );
  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !notification.read),
    [notifications]
  );
  const directoryRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return permissions.filter((permission) => {
      const typeMatches = permission.subjectType === tab;
      const stateMatches = stateFilter === "all" || permission.state === stateFilter;
      const searchMatches =
        !needle ||
        [permission.subjectName, permission.assignment, ...permission.zones]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return typeMatches && stateMatches && searchMatches;
    });
  }, [permissions, search, stateFilter, tab]);

  const metrics = useMemo(
    () => [
      { label: "Active permissions", value: permissions.filter((item) => item.state === "active").length, icon: UsersRound },
      { label: "Pending approval", value: pendingRequests.length, icon: CalendarClock },
      { label: "Restricted", value: permissions.filter((item) => item.state === "restricted" || item.state === "revoked").length, icon: ShieldBan },
      { label: "Unread requests", value: unreadNotifications.length, icon: BellRing },
    ],
    [pendingRequests.length, permissions, unreadNotifications.length]
  );

  async function runQuickAction(permission: AccessPermission) {
    if (permission.state === "pending_approval") {
      const request = pendingRequests.find((item) => item.subjectId === permission.subjectId);
      if (request) document.getElementById(request.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const restore = permission.state !== "active";
    const nextState = restore ? "active" : permission.subjectType === "visitor" ? "revoked" : "restricted";
    const reason = restore
      ? "Access restored by Permission Manager"
      : permission.subjectType === "hardware"
        ? "Hardware restricted by Permission Manager"
        : permission.subjectType === "employee"
          ? "Employee denied entry by Permission Manager"
          : "Visitor permission removed by Permission Manager";
    await updateAccessPermission({
      subjectId: permission.subjectId,
      state: nextState,
      reason,
    });
    setFeedback(`${permission.subjectName}: ${restore ? "access restored" : "access restricted"}.`);
  }

  async function decide(request: PermissionRequest, decision: "approved" | "denied") {
    const reason = decision === "approved"
      ? "Approved by Permission Manager after policy review"
      : "Denied by Permission Manager after policy review";
    await decidePermissionRequest(request.id, decision, reason);
    const relatedNotification = notifications.find(
      (notification) => notification.relatedId === request.id && !notification.read
    );
    if (relatedNotification) await markNotificationRead(relatedNotification.id);
    setFeedback(`${request.subjectName}: request ${decision}.`);
  }

  function openAssignDialog() {
    const firstPermission = permissions.find((permission) => permission.subjectType === tab) ?? permissions[0];
    const now = new Date();
    setSelectedSubjectId(firstPermission?.subjectId ?? "");
    setZones(firstPermission?.zones.join(", ") ?? "Main Entrance");
    setValidFrom(formatLocalInput(now));
    setValidTo(formatLocalInput(new Date(now.getTime() + 8 * 60 * 60 * 1000)));
    setFormError("");
    setAssignOpen(true);
  }

  async function submitAssignment() {
    if (!selectedSubjectId) {
      setFormError("Choose a subject.");
      return;
    }
    if (!validFrom || !validTo || validFrom > validTo) {
      setFormError("Start date must be on or before end date.");
      return;
    }
    if (validFrom < "2016-01-01T00:00") {
      setFormError("Dates before Jan 1, 2016 are not supported.");
      return;
    }
    const permission = permissions.find((item) => item.subjectId === selectedSubjectId);
    await updateAccessPermission({
      subjectId: selectedSubjectId,
      state: "active",
      zones: zones.split(",").map((zone) => zone.trim()).filter(Boolean),
      validFrom,
      validTo,
      reason: "Permission assigned manually by Permission Manager",
    });
    setAssignOpen(false);
    setFeedback(`${permission?.subjectName ?? "Subject"}: permission assigned.`);
  }

  return (
    <div className="permission-page">
      <header className="permission-header">
        <div>
          <h1>Permission Manager</h1>
          <p>Manage entry permissions, visitor approvals, hardware custody, and access decisions.</p>
        </div>
        <button className="permission-primary" type="button" onClick={openAssignDialog}>
          <KeyRound size={17} />
          Assign permission
        </button>
      </header>

      <section className="permission-metrics" aria-label="Permission summary">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div key={label}>
            <Icon size={22} strokeWidth={1.5} />
            <span>
              <small>{label}</small>
              <strong>{value}</strong>
            </span>
          </div>
        ))}
      </section>

      {feedback ? (
        <div className="permission-feedback" role="status">
          <Check size={16} />
          {feedback}
          <button type="button" aria-label="Dismiss status" onClick={() => setFeedback("")}><X size={15} /></button>
        </div>
      ) : null}

      <div className="permission-layout">
        <section className="permission-directory" aria-labelledby="directory-title">
          <div className="permission-section-heading">
            <h2 id="directory-title">Access directory</h2>
            <span>{directoryRows.length} records</span>
          </div>
          <div className="permission-tabs" role="tablist" aria-label="Permission subject type">
            {TAB_LABELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? "is-active" : ""}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="permission-filters">
            <label>
              <Search size={16} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${TAB_LABELS.find((item) => item.id === tab)?.label.toLowerCase()}`}
              />
            </label>
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label="Access state">
              <option value="all">All access states</option>
              <option value="active">Active</option>
              <option value="pending_approval">Pending approval</option>
              <option value="restricted">Restricted</option>
              <option value="revoked">Revoked</option>
              <option value="expired">Expired</option>
            </select>
          </div>
          <div className="permission-table-wrap">
            <table className="permission-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Assignment</th>
                  <th>Access state</th>
                  <th>Zones</th>
                  <th>Valid window</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {directoryRows.map((permission) => (
                  <tr key={permission.id}>
                    <td>
                      <span className="permission-subject-icon">
                        {permission.subjectType === "hardware" ? <Package size={16} /> : permission.subjectName.split(" ").map((part) => part[0]).join("").slice(0, 2)}
                      </span>
                      <span><strong>{permission.subjectName}</strong><small>{permission.subjectType}</small></span>
                    </td>
                    <td>{permission.assignment}</td>
                    <td><span className="permission-state" data-state={permission.state}>{permission.state.replaceAll("_", " ")}</span></td>
                    <td>{permission.zones.join(" / ")}</td>
                    <td><span>{permission.validFrom}</span><small>{permission.validTo}</small></td>
                    <td>
                      <button type="button" className="permission-row-action" onClick={() => void runQuickAction(permission)}>
                        {permissionAction(permission)} <ChevronRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="permission-decisions" aria-labelledby="pending-title">
          <div className="permission-section-heading">
            <h2 id="pending-title">Pending decisions</h2>
            <span>{pendingRequests.length}</span>
          </div>
          <div className="permission-request-list">
            {pendingRequests.length ? pendingRequests.map((request) => (
              <article id={request.id} key={request.id}>
                <div className="request-type">{requestLabel(request)}</div>
                <h3>{request.subjectName}</h3>
                <p>Requested by {request.requester}</p>
                <dl>
                  <div><dt>Purpose</dt><dd>{request.purpose}</dd></div>
                  <div><dt>Access</dt><dd>{request.requestedZones.join(" / ")}</dd></div>
                  <div><dt>Valid</dt><dd>{request.validFrom} - {request.validTo}</dd></div>
                </dl>
                <div className="request-actions">
                  <button type="button" onClick={() => void decide(request, "approved")}>Approve</button>
                  <button type="button" onClick={() => void decide(request, "denied")}>Deny</button>
                </div>
              </article>
            )) : (
              <div className="permission-empty"><Check size={20} /><strong>Queue clear</strong><span>No permission requests need review.</span></div>
            )}
          </div>
        </aside>

      </div>

      {assignOpen ? (
        <div className="permission-dialog-backdrop" role="presentation">
          <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="assign-title">
            <header><div><h2 id="assign-title">Assign permission</h2><p>Grant a scoped, time-bound access permission.</p></div><button type="button" aria-label="Close" onClick={() => setAssignOpen(false)}><X size={18} /></button></header>
            <label><span>Subject</span><select value={selectedSubjectId} onChange={(event) => { setSelectedSubjectId(event.target.value); const permission = permissions.find((item) => item.subjectId === event.target.value); if (permission) setZones(permission.zones.join(", ")); }}>
              {permissions.map((permission) => <option key={permission.id} value={permission.subjectId}>{permission.subjectName} / {permission.subjectType}</option>)}
            </select></label>
            <label><span>Allowed zones</span><input value={zones} onChange={(event) => setZones(event.target.value)} placeholder="Main Entrance, IT Lab" /></label>
            <div className="permission-date-grid">
              <label><span>Valid from</span><input type="datetime-local" min="2016-01-01T00:00" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label>
              <label><span>Valid to</span><input type="datetime-local" min={validFrom || "2016-01-01T00:00"} value={validTo} onChange={(event) => setValidTo(event.target.value)} /></label>
            </div>
            <small>Facility time: UTC+05:30. Start date must not be after end date.</small>
            {formError ? <p className="permission-form-error">{formError}</p> : null}
            <footer><button type="button" onClick={() => setAssignOpen(false)}>Cancel</button><button type="button" onClick={() => void submitAssignment()}>Assign permission</button></footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
