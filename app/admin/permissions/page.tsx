"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check,
  Clock3,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { useDataActions } from "../../../frontend/context/DataContext";
import { readPendingPermissions, readPermissionDirectory, type PendingPermissionPage, type PermissionDirectoryPage } from "../../../services/permissionReadService";
import { createRefreshScheduler } from "../../../lib/refreshScheduler";
import type { AccessPermission, PermissionRequest } from "../../../lib/types";
import { normalizeCheckpointLabel } from "../../../lib/normalizeDashboard";
import { facilityZoneLabel, formatFacilityZones } from "../../../lib/facilityZones";
import { DEFAULT_MANUAL_REVIEW_MINUTES } from "../../../lib/manualReviewDuration";
import { AccessDirectory } from "../../../frontend/components/admin/permissions/AccessDirectory";
import { ManualReviewCard } from "../../../frontend/components/admin/permissions/ManualReviewCard";
import { RequestDialog, type RequestContext } from "../../../frontend/components/admin/permissions/RequestDialog";
import { useOrganizationZones } from "../../../frontend/hooks/useOrganizationZones";
import { formatRequestDate, permissionWindowLabels, requestApprovalLabel, REQUEST_LABELS } from "../../../frontend/components/admin/permissions/requestPresentation";
import requestStyles from "../../../frontend/components/admin/permissions/Requests.module.css";

type DirectoryTab = "people" | "hardware";

export default function PermissionManagerPage() {
  const query = useSearchParams();
  const [directory, setDirectory] = useState<PermissionDirectoryPage | null>(null);
  const [manualPage, setManualPage] = useState<PendingPermissionPage | null>(null);
  const [otherPage, setOtherPage] = useState<PendingPermissionPage | null>(null);
  const [focusedPage, setFocusedPage] = useState<PendingPermissionPage | null>(null);
  const [directoryOffset, setDirectoryOffset] = useState(0);
  const [manualOffset, setManualOffset] = useState(0);
  const [otherOffset, setOtherOffset] = useState(0);
  const [directorySubject, setDirectorySubject] = useState(query.get("subject") || undefined);
  const [revision, setRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const refreshScheduler = useMemo(() => createRefreshScheduler(() => {
    if (activeRead.current) refreshPending.current = true;
    else setRevision(value => value + 1);
  }), []);
  const refresh = useCallback(async () => { setRevision(value => value + 1); }, []);
  const permissions = directory?.items ?? [];
  const people = useMemo(() => [...new Map([...(manualPage?.people ?? []), ...(otherPage?.people ?? []), ...(focusedPage?.people ?? []), ...(directory?.people ?? [])]
    .map(person => [person.id, person])).values()], [manualPage, otherPage, focusedPage, directory]);
  const hardwareAssets = useMemo(() => [...new Map([...(manualPage?.hardwareAssets ?? []), ...(otherPage?.hardwareAssets ?? []), ...(focusedPage?.hardwareAssets ?? []), ...(directory?.hardwareAssets ?? [])]
    .map(asset => [asset.id, asset])).values()], [manualPage, otherPage, focusedPage, directory]);
  const checkpoints = directory?.checkpoints ?? manualPage?.checkpoints ?? [];
  const permissionRequests = useMemo(() => [...new Map([
    ...(focusedPage?.items ?? []), ...(manualPage?.items ?? []), ...(otherPage?.items ?? []),
  ].map(request => [request.id, request])).values()], [focusedPage, manualPage, otherPage]);
  const {
    decidePermissionRequest,
    updatePerson,
    updateHardwareAsset,
  } = useDataActions();
  const { zones: organizationZones } = useOrganizationZones();
  const hardwareById = useMemo(() => new Map(hardwareAssets.map(asset => [asset.id, asset])), [hardwareAssets]);
  const checkpointsById = useMemo(() => new Map(checkpoints.map(checkpoint => [checkpoint.id, checkpoint])), [checkpoints]);
  const permissionsBySubject = useMemo(() => {
    const bySubject = new Map<string, AccessPermission>();
    for (const permission of permissions) {
      if (!bySubject.has(permission.subjectId)) bySubject.set(permission.subjectId, permission);
    }
    return bySubject;
  }, [permissions]);
  const checkpointLabel = (checkpointId?: string) => {
    const checkpoint = checkpointId ? checkpointsById.get(checkpointId) : undefined;
    return checkpoint ? `${facilityZoneLabel(checkpoint.zoneId ?? checkpoint.zone, organizationZones)} · ${checkpoint.name}` : checkpointId || "Not specified";
  };
  const requestedCheckpointLabel = (checkpointIds?: string[]) => checkpointIds?.map((id) => checkpointLabel(id)).join(", ") ?? "";
  const [tab, setTab] = useState<DirectoryTab>("people");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
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
  const handledQueryRef = useRef("");
  const focusedVersionRef = useRef(-1);
  const focusedSubjectRef = useRef("");
  const decisionNoteRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setDirectoryOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const reload = () => refreshScheduler.request();
    window.addEventListener("inout:presence-message", reload);
    window.addEventListener("inout:presence-sync", reload);
    const restore = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      refreshScheduler.cancel();
      window.removeEventListener("inout:presence-message", reload);
      window.removeEventListener("inout:presence-sync", reload);
      window.removeEventListener("focus", restore);
      window.removeEventListener("online", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [refreshScheduler]);
  useEffect(() => {
    if (search !== debouncedSearch) return;
    const controller = new AbortController();
    activeRead.current = controller;
    refreshPending.current = false;
    refreshScheduler.cancel();
    setIsLoading(true);
    setError(null);
    const subjectId = query.get("subject") || undefined;
    const requestId = query.get("request") || undefined;
    void Promise.all([
      readPermissionDirectory({ limit: 25, offset: directoryOffset, search: debouncedSearch.trim() || undefined, subjectGroup: directorySubject ? undefined : tab, state: stateFilter === "all" ? undefined : stateFilter, subjectId: directorySubject }, controller.signal),
      readPendingPermissions({ limit: 25, offset: manualOffset, typeGroup: "manual" }, controller.signal),
      readPendingPermissions({ limit: 25, offset: otherOffset, typeGroup: "other" }, controller.signal),
      subjectId || requestId ? readPendingPermissions({ limit: 1, offset: 0, subjectId, requestId }, controller.signal) : Promise.resolve(null),
    ]).then(([directoryResult, manualResult, otherResult, focusedResult]) => {
      if (controller.signal.aborted) return;
      setDirectory(directoryResult);
      setManualPage(manualResult);
      setOtherPage(otherResult);
      setFocusedPage(focusedResult);
      for (const [result, setOffset] of [[directoryResult, setDirectoryOffset], [manualResult, setManualOffset], [otherResult, setOtherOffset]] as const) {
        if (result.offset > 0 && result.offset >= result.total) setOffset(Math.max(0, Math.ceil(result.total / 25) - 1) * 25);
      }
      const revisions = [directoryResult.eventRevision, manualResult.eventRevision, otherResult.eventRevision].filter((value): value is number => Number.isSafeInteger(value));
      if (revisions.length === 3) window.dispatchEvent(new CustomEvent("inout:snapshot-revision", { detail: { revision: Math.min(...revisions), scope: "permissions" } }));
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Unable to load permissions.");
      controller.abort();
      activeRead.current = null;
      setIsLoading(false);
      if (refreshPending.current) { refreshPending.current = false; refreshScheduler.request(); }
    })
      .finally(() => {
        if (controller.signal.aborted) return;
        activeRead.current = null;
        setIsLoading(false);
        if (refreshPending.current) { refreshPending.current = false; refreshScheduler.request(); }
      });
    return () => { controller.abort(); if (activeRead.current === controller) activeRead.current = null; };
  }, [debouncedSearch, search, tab, stateFilter, directorySubject, directoryOffset, manualOffset, otherOffset, revision, query, refreshScheduler]);

  async function runAction(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setActionError("");
    try {
      await action();
      void refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save the permission decision.");
      await refresh().catch(() => {});
      return false;
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

  function revokePermission(permission: AccessPermission) {
    return runAction(async () => {
      if (permission.subjectType === "hardware") {
        await updateHardwareAsset(permission.subjectId, { status: "restricted" });
      } else {
        await updatePerson(permission.subjectId, { status: "restricted" });
      }
      setFeedback(`${permission.subjectName}: access revoked and marked restricted.`);
    });
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
      setDirectorySubject(subjectId);
      setDirectoryOffset(0);
      const permission = permissionsBySubject.get(subjectId);
      setTab(permission?.subjectType === "hardware" || hardwareById.has(subjectId) ? "hardware" : "people");
      setSearch(""); setStateFilter("all");
    }
    const request = permissionRequests.find((item) => requestId ? item.id === requestId : item.subjectId === subjectId && item.status === "pending");
    if (request?.status === "pending") focusRequest(request.id);
    else if (request) setFeedback(`${request.subjectName}: this permission request has already been decided.`);
    else if (requestId) setFeedback("This permission request is no longer pending.");
  }, [query, isLoading, error, permissionsBySubject, permissionRequests, hardwareById]);

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
  const directoryRows = permissions;
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
      const removeDecided = (current: PendingPermissionPage | null) => current ? { ...current,
        items: current.items.filter(item => item.id !== request.id),
        total: Math.max(0, current.total - 1),
      } : current;
      if (request.type === "manual_override") setManualPage(removeDecided);
      else setOtherPage(removeDecided);
      setFocusedPage(current => current ? { ...current, items: current.items.filter(item => item.id !== request.id) } : current);
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

  function pageControls(label: string, offset: number, total: number, setOffset: (offset: number) => void) {
    return total > 25 ? <nav className="pagination" aria-label={label}>
      <button className={requestStyles.contextLink} type="button" disabled={busy || isLoading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button>
      <span>{offset + 1}–{Math.min(offset + 25, total)} of {total}</span>
      <button className={requestStyles.contextLink} type="button" disabled={busy || isLoading || offset + 25 >= total} onClick={() => setOffset(offset + 25)}>Next</button>
    </nav> : null;
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
        <AccessDirectory rows={directoryRows} hardwareAssets={hardwareAssets} checkpoints={checkpoints} zoneLabels={organizationZones} tab={tab} onTabChange={value => { setTab(value); setDirectoryOffset(0); setDirectorySubject(undefined); }}
          search={search} onSearchChange={value => { setSearch(value); setDirectorySubject(undefined); }} stateFilter={stateFilter} onStateFilterChange={value => { setStateFilter(value); setDirectoryOffset(0); setDirectorySubject(undefined); }}
          highlightedSubjectId={highlightSubjectId} busy={busy} isLoading={isLoading} error={error} total={directory?.total ?? 0}
          pagination={pageControls("Access directory pages", directoryOffset, directory?.total ?? 0, setDirectoryOffset)}
          onReviewRequest={(permission) => {
            const request = pendingRequests.find((item) => item.subjectId === permission.subjectId);
            if (request) focusRequest(request.id);
            else setFeedback("This subject has no pending request to review.");
          }}
          onManageAccess={(permission) => setRequestContext({ subjectId: permission.subjectId, type: "zone_access" })}
          onReassign={(permission) => setRequestContext({ subjectId: permission.subjectId, type: "hardware_custody" })} />
        <div className={requestStyles.queueColumn}>
          <section className={requestStyles.queuePanel} aria-labelledby="manual-review-title">
            <div className={requestStyles.queueHeading}>
              <div className={requestStyles.sectionTitle}><span className={requestStyles.reviewIcon} aria-hidden="true"><Clock3 size={20} strokeWidth={1.7} /></span><div><h2 id="manual-review-title">Manual reviews</h2><p>Terminal exceptions awaiting a decision.</p></div></div>
              <span className={requestStyles.queueCount}>{manualPage?.total ?? 0} pending</span>
            </div>
            <div className={`${requestStyles.reviewList} scrollable-content`}>
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
                checkpointName={normalizeCheckpointLabel(request.checkpoint) || checkpoints.find((checkpoint) => checkpoint.id === request.checkpointId)?.name || request.checkpointId}
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
            {pageControls("Manual review pages", manualOffset, manualPage?.total ?? 0, setManualOffset)}
          </section>

          {(otherPendingRequests.length > 0 || (otherPage?.total ?? 0) > 0) && (
            <section className={requestStyles.queuePanel} aria-labelledby="other-pending-title">
              <div className={requestStyles.queueHeading}>
                <h2 id="other-pending-title">Other pending permissions</h2>
                <span className={requestStyles.queueCount}>{otherPage?.total ?? 0} pending</span>
              </div>
              <div className={`${requestStyles.reviewList} scrollable-content`}>
                {otherPendingRequests.map((request) => (
              <article id={request.id} key={request.id} tabIndex={-1} className={`${requestStyles.otherRequest} ${request.type === "visitor" ? requestStyles.visitorRequest : ""} ${selectedRequestId === request.id ? requestStyles.selected : ""}`}>
                {request.type === "visitor" ? (
                  <>
                    <header className={requestStyles.visitorRequestHeader}>
                      <span className={requestStyles.visitorRequestAvatar} aria-hidden="true">{request.subjectName.split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
                      <div className={requestStyles.visitorRequestIdentity}>
                        <div className={requestStyles.visitorRequestNameLine}>
                          <h3>{request.subjectName}</h3>
                          {request.barcode ? <span className={requestStyles.visitorBarcode}>{request.barcode}</span> : null}
                          <span className={requestStyles.visitorPendingState}><span aria-hidden="true" />Pending</span>
                        </div>
                        <span className={requestStyles.visitorRequestType}>Visitor · {requestedCheckpointLabel(request.requestedCheckpoints) || formatFacilityZones(request.requestedZones, organizationZones) || "No zones assigned"}</span>
                      </div>
                    </header>
                    <p className={requestStyles.requestMeta}>{request.purpose} · Requested by {request.requester} · {formatRequestDate(request.createdAt)}</p>
                    <dl className={requestStyles.visitorRequestDetails}>
                      <div><dt>{request.requestedCheckpoints?.length ? "Checkpoint access" : "Checkpoint"}</dt><dd>{requestedCheckpointLabel(request.requestedCheckpoints) || checkpointLabel(request.checkpointId)}</dd></div>
                      {!request.requestedCheckpoints?.length && <div><dt>Requested zones</dt><dd>{formatFacilityZones(request.requestedZones, organizationZones) || "None"}</dd></div>}
                      <div><dt>Access</dt><dd>{permissionWindowLabels(request.validFrom, request.validTo).start.replace(/^Starts /, "")}</dd></div>
                      <div><dt>Expires</dt><dd>{permissionWindowLabels(request.validFrom, request.validTo).end.replace(/^Ends /, "")}</dd></div>
                    </dl>
                  </>
                ) : (
                  <>
                    <span className={requestStyles.badge} data-type={request.type}>{REQUEST_LABELS[request.type]}</span>
                    <h3>{request.subjectName}{request.barcode ? ` · ${request.barcode}` : ""}</h3>
                    <p className={requestStyles.requestMeta}>{request.purpose}<br />Requested by {request.requester} · {formatRequestDate(request.createdAt)}</p>
                    <dl>
                      <div><dt>Checkpoint</dt><dd>{checkpointLabel(request.checkpointId)}</dd></div>
                      {request.type !== "hardware_custody" && <div><dt>Requested zones</dt><dd>{formatFacilityZones(request.requestedZones, organizationZones) || "None"}</dd></div>}
                      {request.direction ? <div><dt>Movement</dt><dd>{request.direction === "entry" ? "Entry" : "Exit"}</dd></div> : null}
                      {request.eventId && <div><dt>Denied scan</dt><dd><a href={`/admin/logs?eventId=${encodeURIComponent(request.eventId)}`}>{request.eventId}</a></dd></div>}
                      {request.type !== "hardware_custody" && <div><dt>Requested window</dt><dd>{permissionWindowLabels(request.validFrom, request.validTo).start}<br />{permissionWindowLabels(request.validFrom, request.validTo).end}</dd></div>}
                    </dl>
                    {request.type === "hardware_custody" && <div className={`${requestStyles.comparison} admin-surface`}><strong>Custodian change</strong><span>{hardwareAssets.find((asset) => asset.id === (request.hardwareId || request.subjectId))?.assignedEmployeeName || "Unassigned"} → {request.carrierName || request.carrierId || "No employee selected"}</span><span>Reassigns custody until the next reassignment. Zone access stays separate.</span></div>}
                    {request.type === "zone_access" && <div className={`${requestStyles.comparison} admin-surface`}><strong>Current → proposed access</strong><span>{formatFacilityZones(permissions.find((item) => item.subjectId === request.subjectId)?.zones ?? people.find((item) => item.id === request.subjectId)?.allowedZones ?? hardwareAssets.find((item) => item.id === request.subjectId)?.allowedZones ?? [], organizationZones) || "No current zones"} → {formatFacilityZones(request.requestedZones, organizationZones) || "None"}</span><span>Window when requested: {permissionWindowLabels(request.previousValidFrom, request.previousValidTo).start} / {permissionWindowLabels(request.previousValidFrom, request.previousValidTo).end}</span><span>Replaces the complete zone set and valid window.</span></div>}
                  </>
                )}
                {request.operatorNote ? <p className="permission-request-note">{request.operatorNote}</p> : null}
                <>
                <label className={`${request.type === "visitor" ? requestStyles.visitorRequestNote : ""} permission-decision-note`}>
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
                <div className={request.type === "visitor" ? requestStyles.visitorRequestActions : "request-decision-controls"}>
                  <div className="request-actions">
                    <button type="button" className="permission-approve-button" disabled={busy} onClick={() => void decide(request, "approved")}>{requestApprovalLabel(request)}</button>
                    <button type="button" className="permission-deny-button" disabled={busy} onClick={() => void decide(request, "denied")}>Deny</button>
                  </div>
                </div>
                </>
              </article>
                ))}
              </div>
              {pageControls("Other permission pages", otherOffset, otherPage?.total ?? 0, setOtherOffset)}
            </section>
          )}
        </div>
      </div>

      {requestContext && <RequestDialog mode="grant" context={requestContext} checkpoints={checkpoints} onClose={() => setRequestContext(null)} onReview={(requestId) => { setRequestContext(null); focusRequest(requestId); }} onRevokeAccess={revokePermission} onSubmitted={(request, group) => { setRequestContext(null); setFeedback(`${request.subjectName}: ${REQUEST_LABELS[request.type].toLowerCase()} granted.`); setHighlightSubjectId(request.subjectId); setDirectorySubject(request.subjectId); setDirectoryOffset(0); setTab(group ?? (request.type === "hardware_custody" || hardwareById.has(request.subjectId) ? "hardware" : "people")); setSearch(""); setStateFilter("all"); void refresh(); }} />}
    </div>
  );
}
