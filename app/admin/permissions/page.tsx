"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check,
  Clock3,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import type { AccessPermission, PermissionRequest } from "../../../lib/types";
import { formatFacilityZones } from "../../../lib/facilityZones";
import { DEFAULT_MANUAL_REVIEW_MINUTES } from "../../../lib/manualReviewDuration";
import { AccessDirectory } from "../../../frontend/components/admin/permissions/AccessDirectory";
import { ManualReviewCard } from "../../../frontend/components/admin/permissions/ManualReviewCard";
import { RequestDialog, type RequestContext } from "../../../frontend/components/admin/permissions/RequestDialog";
import { formatRequestDate, permissionDisplayState, permissionWindowLabels, requestApprovalLabel, REQUEST_LABELS } from "../../../frontend/components/admin/permissions/requestPresentation";
import requestStyles from "../../../frontend/components/admin/permissions/Requests.module.css";

type DirectoryTab = "people" | "hardware";

function isOneTimeManualReviewRecord(permission: AccessPermission) {
  const isUnregisteredPlaceholder = permission.subjectName.trim().toLowerCase() === "unregistered barcode";
  const isOneTimeReview = permission.subjectType === "visitor" && permission.assignment === "One visit" &&
    (permission.updatedBy === "manual-review" || permission.reason?.startsWith("Manual approval covers one entry"));
  return isUnregisteredPlaceholder || isOneTimeReview;
}

export default function PermissionManagerPage() {
  const {
    permissions,
    permissionRequests,
    people,
    hardwareAssets,
    checkpoints,
    isLoading,
    error,
  } = useDataState();
  const {
    decidePermissionRequest,
    releaseEntryRestriction,
    refresh,
  } = useDataActions();
  const [tab, setTab] = useState<DirectoryTab>("people");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [feedback, setFeedback] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [invalidDecisionNotes, setInvalidDecisionNotes] = useState<Record<string, boolean>>({});
  const [validForMinutes, setValidForMinutes] = useState<Record<string, number>>({});
  const [requestContext, setRequestContext] = useState<RequestContext | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [requestFocusVersion, setRequestFocusVersion] = useState(0);
  const [highlightSubjectId, setHighlightSubjectId] = useState("");
  const query = useSearchParams();
  const handledQueryRef = useRef("");
  const focusedVersionRef = useRef(-1);
  const focusedSubjectRef = useRef("");
  const decisionNoteRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});

  async function runAction(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save the permission decision.");
    } finally {
      setBusy(false);
    }
  }

  const pendingRequests = useMemo(
    () => permissionRequests.filter((request) => request.status === "pending"),
    [permissionRequests]
  );
  const manualReviewRequests = useMemo(() => pendingRequests
    .filter((request) => request.type === "manual_override")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)), [pendingRequests]);
  const otherPendingRequests = useMemo(() => pendingRequests
    .filter((request) => request.type !== "manual_override")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)), [pendingRequests]);

  function focusRequest(requestId: string) {
    setSelectedRequestId(requestId);
    setRequestFocusVersion((value) => value + 1);
  }

  useEffect(() => {
    const queryKey = query.toString();
    if (isLoading || error || !queryKey || handledQueryRef.current === queryKey) return;
    handledQueryRef.current = queryKey;
    const requestId = query.get("request");
    const subjectId = query.get("subject");
    const requestedType = query.get("requestType");
    if (requestedType && requestedType !== "manual_override" && Object.hasOwn(REQUEST_LABELS, requestedType)) {
      setRequestContext({ type: requestedType as PermissionRequest["type"], subjectId: subjectId ?? undefined });
    }
    if (subjectId) {
      setHighlightSubjectId(subjectId);
      const permission = permissions.find((item) => item.subjectId === subjectId);
      setTab(permission?.subjectType === "hardware" || hardwareAssets.some((item) => item.id === subjectId) ? "hardware" : "people");
      setSearch(""); setStateFilter("all");
    }
    const request = permissionRequests.find((item) => requestId ? item.id === requestId : item.subjectId === subjectId && item.status === "pending");
    if (request?.status === "pending") focusRequest(request.id);
    else if (request) setFeedback(`${request.subjectName}: this permission request has already been decided.`);
    else if (requestId) setFeedback("This permission request is no longer pending.");
  }, [query, isLoading, error, permissions, permissionRequests, hardwareAssets]);

  useEffect(() => {
    if (!selectedRequestId || requestContext || focusedVersionRef.current === requestFocusVersion) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(selectedRequestId);
      card?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      card?.focus({ preventScroll: true });
      if (card) focusedVersionRef.current = requestFocusVersion;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedRequestId, pendingRequests, requestContext, requestFocusVersion]);
  const managedPermissions = useMemo(
    () => permissions.filter((permission) => !isOneTimeManualReviewRecord(permission)),
    [permissions]
  );
  const directoryRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return managedPermissions.filter((permission) => {
      const typeMatches = tab === "people"
        ? permission.subjectType === "employee" || permission.subjectType === "visitor"
        : permission.subjectType === "hardware";
      const stateMatches = stateFilter === "all" || permissionDisplayState(permission) === stateFilter;
      const searchMatches =
        !needle ||
        [permission.subjectName, permission.assignment, people.find((person) => person.id === permission.subjectId)?.barcode, hardwareAssets.find((asset) => asset.id === permission.subjectId)?.barcode, hardwareAssets.find((asset) => asset.id === permission.subjectId)?.assignedEmployeeName, ...permission.zones, formatFacilityZones(permission.zones)]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return typeMatches && stateMatches && searchMatches;
    }).sort((left, right) => left.subjectName.localeCompare(right.subjectName));
  }, [managedPermissions, search, stateFilter, tab, people, hardwareAssets]);
  useEffect(() => {
    if (!highlightSubjectId || selectedRequestId || requestContext || focusedSubjectRef.current === highlightSubjectId) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(`permission-${highlightSubjectId}`);
      if (!card) return;
      card.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      card.focus({ preventScroll: true });
      focusedSubjectRef.current = highlightSubjectId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightSubjectId, selectedRequestId, requestContext, directoryRows]);
  async function decide(request: PermissionRequest, decision: "approved" | "denied") {
    if (busy) return;
    const reason = decisionNotes[request.id]?.trim();
    if (decision === "denied" && !reason) {
      setInvalidDecisionNotes((current) => ({ ...current, [request.id]: true }));
      decisionNoteRefs.current[request.id]?.focus();
      return;
    }
    await runAction(async () => {
      await decidePermissionRequest(
        request.id,
        decision,
        reason ?? "",
        decision === "approved" && request.type === "manual_override" ? (validForMinutes[request.id] ?? DEFAULT_MANUAL_REVIEW_MINUTES) : undefined
      );
      setDecisionNotes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setInvalidDecisionNotes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setValidForMinutes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setSelectedRequestId("");
      setFeedback(`${request.subjectName}: permission ${decision === "approved" ? "approved" : "denied"}.`);
    });
  }

  return (
    <div className={requestStyles.page}>
      {actionError ? <p className={requestStyles.pageError} role="alert">{actionError}</p> : null}
      {error ? (
        <div className={requestStyles.pageError} role="alert">
          <span>Permission data could not be loaded: {error}</span>
          <button className={requestStyles.contextLink} type="button" disabled={isLoading} onClick={() => void refresh()}>
            {isLoading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      <header className={requestStyles.pageHeader}>
        <div>
          <h1>Permission Manager</h1>
        </div>
        <button className={requestStyles.newPermission} type="button" onClick={() => setRequestContext({})}><Plus size={17} />New permission</button>
      </header>

      {feedback ? (
        <div className={requestStyles.feedback} role="status">
          <Check size={16} />
          <span>{feedback}</span>
          <button type="button" aria-label="Dismiss status" onClick={() => setFeedback("")}><X size={15} /></button>
        </div>
      ) : null}

      <div className={requestStyles.managerLayout}>
        <AccessDirectory rows={directoryRows} hardwareAssets={hardwareAssets} tab={tab} onTabChange={setTab}
          search={search} onSearchChange={setSearch} stateFilter={stateFilter} onStateFilterChange={setStateFilter}
          highlightedSubjectId={highlightSubjectId} busy={busy} isLoading={isLoading} error={error} total={managedPermissions.length}
          onReviewRequest={(permission) => {
            const request = pendingRequests.find((item) => item.subjectId === permission.subjectId);
            if (request) focusRequest(request.id);
            else setFeedback("This subject has no pending request to review.");
          }}
          onManageAccess={(permission) => setRequestContext({ subjectId: permission.subjectId, type: "zone_access" })}
          onReassign={(permission) => setRequestContext({ subjectId: permission.subjectId, type: "hardware_custody" })}
          onReleaseRestriction={(permission, reason) => { void runAction(async () => {
            if (!permission.entryRestriction?.active) return;
            await releaseEntryRestriction(permission.entryRestriction.triggerAlertId, reason);
            setFeedback(`${permission.subjectName}: entry restriction lifted. Their entry zones and valid window still apply.`);
          }); }} />
        <div className={requestStyles.queueColumn}>
          <section className={requestStyles.queuePanel} aria-labelledby="manual-review-title">
            <div className={requestStyles.queueHeading}>
              <div className={requestStyles.sectionTitle}><span className={requestStyles.reviewIcon} aria-hidden="true"><Clock3 size={20} strokeWidth={1.7} /></span><div><h2 id="manual-review-title">Manual reviews</h2><p>Terminal exceptions awaiting a decision.</p></div></div>
              <span className={requestStyles.queueCount}>{manualReviewRequests.length} pending</span>
            </div>
            <div className={requestStyles.reviewList}>
              {isLoading && pendingRequests.length === 0 ? (
                <div className={requestStyles.queueEmpty} role="status">Loading manual reviews…</div>
              ) : error && pendingRequests.length === 0 ? (
                <div className={requestStyles.queueEmpty}>Manual reviews are unavailable. Use Retry above.</div>
              ) : manualReviewRequests.length ? manualReviewRequests.map((request) => (
              <ManualReviewCard
                key={request.id}
                id={request.id}
                tabIndex={-1}
                className={`${requestStyles.requestCard} ${selectedRequestId === request.id ? requestStyles.selected : ""}`}
                request={request}
                checkpointName={request.checkpoint || checkpoints.find((checkpoint) => checkpoint.id === request.checkpointId)?.name || request.checkpointId}
                decisionNote={decisionNotes[request.id] ?? ""}
                noteInvalid={Boolean(invalidDecisionNotes[request.id])}
                noteInputRef={(node) => { decisionNoteRefs.current[request.id] = node; }}
                onNoteChange={(value) => {
                  setDecisionNotes((current) => ({ ...current, [request.id]: value }));
                  if (value.trim()) {
                    setInvalidDecisionNotes((current) => current[request.id] ? { ...current, [request.id]: false } : current);
                  }
                }}
                validForMinutes={validForMinutes[request.id] ?? DEFAULT_MANUAL_REVIEW_MINUTES}
                onDurationChange={(minutes) => setValidForMinutes((current) => ({ ...current, [request.id]: minutes }))}
                disabled={busy}
                onDecision={(decision) => { void decide(request, decision); }}
              />
              )) : (
                <div className={requestStyles.queueEmpty}><span className={requestStyles.emptyIcon}><ShieldCheck size={28} strokeWidth={1.4} /></span><strong>All caught up</strong><span>New terminal manual reviews will appear here.</span></div>
              )}
            </div>
          </section>

          {otherPendingRequests.length > 0 && (
            <section className={requestStyles.queuePanel} aria-labelledby="other-pending-title">
              <div className={requestStyles.queueHeading}>
                <h2 id="other-pending-title">Other pending permissions</h2>
                <span className={requestStyles.queueCount}>{otherPendingRequests.length} pending</span>
              </div>
              <div className={requestStyles.reviewList}>
                {otherPendingRequests.map((request) => (
              <article id={request.id} key={request.id} tabIndex={-1} className={`${requestStyles.otherRequest} ${selectedRequestId === request.id ? requestStyles.selected : ""}`}>
                <span className={requestStyles.badge} data-type={request.type}>{REQUEST_LABELS[request.type]}</span>
                <h3>{request.subjectName}{request.barcode ? ` · ${request.barcode}` : ""}</h3>
                <p className={requestStyles.requestMeta}>{request.purpose}<br />Requested by {request.requester} · {formatRequestDate(request.createdAt)}</p>
                <dl>
                  <div><dt>Checkpoint</dt><dd>{checkpoints.find((checkpoint) => checkpoint.id === request.checkpointId)?.name || request.checkpointId || "Not specified"}</dd></div>
                  {request.type !== "hardware_custody" && <div><dt>Requested zones</dt><dd>{formatFacilityZones(request.requestedZones) || "None"}</dd></div>}
                  {request.direction ? <div><dt>Movement</dt><dd>{request.direction === "entry" ? "Entry" : "Exit"}</dd></div> : null}
                  {request.eventId && <div><dt>Denied scan</dt><dd><a href={`/admin/logs?eventId=${encodeURIComponent(request.eventId)}`}>{request.eventId}</a></dd></div>}
                  {request.type !== "hardware_custody" && <div><dt>Requested window</dt><dd>{permissionWindowLabels(request.validFrom, request.validTo).start}<br />{permissionWindowLabels(request.validFrom, request.validTo).end}</dd></div>}
                </dl>
                {request.type === "hardware_custody" && <div className={`${requestStyles.comparison} admin-surface`}><strong>Custodian change</strong><span>{request.previousCarrierName || hardwareAssets.find((asset) => asset.id === (request.hardwareId || request.subjectId))?.assignedEmployeeName || "Unassigned"} → {request.carrierName || request.carrierId || "No employee selected"}</span><span>Reassigns custody until the next reassignment. Zone access stays separate.</span></div>}
                {request.type === "zone_access" && <div className={`${requestStyles.comparison} admin-surface`}><strong>Current → proposed access</strong><span>{formatFacilityZones(request.previousZones ?? permissions.find((item) => item.subjectId === request.subjectId)?.zones ?? people.find((item) => item.id === request.subjectId)?.allowedZones ?? hardwareAssets.find((item) => item.id === request.subjectId)?.allowedZones ?? []) || "No current zones"} → {formatFacilityZones(request.requestedZones) || "None"}</span><span>Previous window: {permissionWindowLabels(request.previousValidFrom, request.previousValidTo).start} / {permissionWindowLabels(request.previousValidFrom, request.previousValidTo).end}</span><span>Replaces the complete zone set and valid window.</span></div>}
                {request.operatorNote ? <p className="permission-request-note">{request.operatorNote}</p> : null}
                <>
                <label className="permission-decision-note">
                  <span>Operator note</span>
                  <textarea className="admin-surface"
                    ref={(node) => { decisionNoteRefs.current[request.id] = node; }}
                    aria-invalid={invalidDecisionNotes[request.id] || undefined}
                    value={decisionNotes[request.id] ?? ""}
                    disabled={busy}
                    maxLength={1000}
                    placeholder="Add a note if you deny this permission."
                    onChange={(event) => {
                      const value = event.target.value;
                      setDecisionNotes((current) => ({ ...current, [request.id]: value }));
                      if (value.trim()) {
                        setInvalidDecisionNotes((current) => current[request.id] ? { ...current, [request.id]: false } : current);
                      }
                    }}
                  />
                </label>
                <div className="request-decision-controls">
                  <div className="request-actions">
                    <button type="button" className="permission-approve-button" disabled={busy} onClick={() => void decide(request, "approved")}>{requestApprovalLabel(request)}</button>
                    <button type="button" className="permission-deny-button" disabled={busy} onClick={() => void decide(request, "denied")}>Deny</button>
                  </div>
                </div>
                </>
              </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {requestContext && <RequestDialog mode="grant" context={requestContext} onClose={() => setRequestContext(null)} onReview={(requestId) => { setRequestContext(null); focusRequest(requestId); }} onSubmitted={(request) => { setRequestContext(null); setFeedback(`${request.subjectName}: ${REQUEST_LABELS[request.type].toLowerCase()} granted.`); setHighlightSubjectId(request.subjectId); setTab(request.type === "hardware_custody" || hardwareAssets.some((asset) => asset.id === request.subjectId) ? "hardware" : "people"); setSearch(""); setStateFilter("all"); void refresh(); }} />}
    </div>
  );
}
