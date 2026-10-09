"use client";

import Link from "next/link";
import { Check, ChevronRight, Clock3, MapPin, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useDataActions, useDataState } from "../../context/DataContext";
import type { PermissionRequest } from "../../../lib/types";
import { DEFAULT_MANUAL_REVIEW_MINUTES, MANUAL_REVIEW_DURATIONS } from "../../../lib/manualReviewDuration";

export function PendingDecisionsWidget({
  requests,
  limit = 5,
}: {
  requests: PermissionRequest[];
  limit?: number;
}) {
  const { decidePermissionRequest } = useDataActions();
  const { checkpoints } = useDataState();
  const workingRef = useRef(false);
  const decisionNoteRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [validForMinutes, setValidForMinutes] = useState<Record<string, number>>({});
  const [missingDecisionNoteId, setMissingDecisionNoteId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const pendingRequests = useMemo(
    () => requests
      .filter((request) => request.status === "pending")
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit),
    [limit, requests]
  );

  async function decide(request: PermissionRequest, decision: "approved" | "denied") {
    if (workingRef.current) return;
    const reason = decisionNotes[request.id]?.trim() ?? "";
    if (decision === "denied" && !reason) {
      setMissingDecisionNoteId(request.id);
      setError("");
      decisionNoteRefs.current[request.id]?.focus();
      return;
    }
    setMissingDecisionNoteId(null);
    setWorkingId(request.id);
    workingRef.current = true;
    setError("");
    setFeedback("");
    try {
      await decidePermissionRequest(
        request.id,
        decision,
        reason,
        decision === "approved" && request.type === "manual_override" ? (validForMinutes[request.id] ?? DEFAULT_MANUAL_REVIEW_MINUTES) : undefined
      );
      setValidForMinutes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setFeedback(`${request.subjectName}: ${decision === "approved" ? "approved" : "denied"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save this decision. Please try again.");
    } finally {
      setWorkingId(null);
      workingRef.current = false;
    }
  }

  function updateDecisionNote(requestId: string, value: string) {
    setDecisionNotes((current) => ({ ...current, [requestId]: value }));
    if (value.trim()) {
      setMissingDecisionNoteId((current) => current === requestId ? null : current);
    }
  }

  return (
    <section
      className="dashboard-alert-widget alert-widget-box"
      aria-labelledby="pending-decisions-heading"
    >
      <header className="alert-widget-header">
        <Link
          className="alert-widget-title-link"
          href="/admin/permissions"
          aria-label="Open pending permissions"
        >
          <h2 id="pending-decisions-heading">Pending Permissions</h2>
          <ChevronRight
            className="alert-widget-title-chevron"
            aria-hidden="true"
            size={18}
          />
        </Link>
      </header>

      {error ? <p className="pending-decision-error" role="alert">{error}</p> : null}
      {feedback ? <p className="pending-decision-request-note" role="status">{feedback}</p> : null}

      {pendingRequests.length ? (
        <ul className="alert-list-container pending-decision-list">
          {pendingRequests.map((request) => {
            const busy = workingId === request.id;
            const checkpointName = request.checkpoint || checkpoints.find((checkpoint) => checkpoint.id === request.checkpointId)?.name || request.checkpointId;
            const isManualReview = request.type === "manual_override";
            return (
              <li key={request.id}>
                <article className="pending-decision-card">
                  <span className="pending-decision-icon" aria-hidden="true">
                    <Clock3 size={17} strokeWidth={1.8} />
                  </span>
                  <div className="alert-item-main">
                    <span className="alert-item-title pending-decision-barcode-title">
                      {request.subjectName}{request.barcode ? ` · ${request.barcode}` : ""}
                    </span>
                    {(checkpointName || !isManualReview) && <div className="pending-decision-context">
                      {!isManualReview && <span>{request.type === "hardware_custody" ? "Hardware custody" : request.type === "zone_access" ? "Zone access" : "Visitor access"}</span>}
                      {checkpointName && <span className="pending-decision-context-checkpoint"><MapPin size={13} aria-hidden="true" />{checkpointName}</span>}
                    </div>}
                    <label className={`pending-decision-note pending-decision-note-single-line${missingDecisionNoteId === request.id ? " pending-decision-note-invalid" : ""}`}>
                      <span className="sr-only">Decision note</span>
                      <input
                        ref={(element) => { decisionNoteRefs.current[request.id] = element; }}
                        type="text"
                        value={decisionNotes[request.id] ?? ""}
                        disabled={busy}
                        aria-invalid={missingDecisionNoteId === request.id}
                        aria-label={`Decision note for ${request.subjectName}; required to deny`}
                        maxLength={1000}
                        placeholder="Add a note if you deny this permission."
                        onChange={(event) => updateDecisionNote(request.id, event.target.value)}
                      />
                    </label>
                    <div className="pending-decision-controls">
                      {isManualReview && <label className="pending-decision-valid-for">
                        <span>Valid for</span>
                        <select
                          value={validForMinutes[request.id] ?? DEFAULT_MANUAL_REVIEW_MINUTES}
                          disabled={Boolean(workingId)}
                          onChange={(event) => setValidForMinutes((current) => ({ ...current, [request.id]: Number(event.target.value) }))}
                        >
                          {MANUAL_REVIEW_DURATIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
                        </select>
                      </label>}
                      <span className="pending-decision-actions">
                        <button
                          type="button"
                          className="pending-decision-approve"
                          aria-label={`Approve ${request.subjectName}`}
                          title="Approve"
                          disabled={Boolean(workingId)}
                          onClick={() => void decide(request, "approved")}
                        >
                          <Check size={16} strokeWidth={2.2} />
                          <span>Approve</span>
                        </button>
                        <button
                          type="button"
                          className="pending-decision-deny"
                          aria-label={`Deny ${request.subjectName}`}
                          title="Deny"
                          disabled={Boolean(workingId)}
                          onClick={() => void decide(request, "denied")}
                        >
                          <X size={16} strokeWidth={2.2} />
                          <span>Deny</span>
                        </button>
                      </span>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="alert-widget-empty">
          <div>
            <strong>No pending permissions</strong>
            <span>All permission requests are up to date.</span>
          </div>
        </div>
      )}

    </section>
  );
}
