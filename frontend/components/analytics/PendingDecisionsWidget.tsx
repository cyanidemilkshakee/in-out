"use client";

import Link from "next/link";
import { Check, ChevronRight, Clock3, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useDataActions } from "../../context/DataContext";
import type { PermissionRequest } from "../../../lib/types";

const VALID_FOR_OPTIONS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
];

export function PendingDecisionsWidget({
  requests,
  limit = 5,
}: {
  requests: PermissionRequest[];
  limit?: number;
}) {
  const { decidePermissionRequest } = useDataActions();
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [validForMinutes, setValidForMinutes] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const pendingRequests = useMemo(
    () => requests
      .filter((request) => request.status === "pending")
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit),
    [limit, requests]
  );

  async function decide(request: PermissionRequest, decision: "approved" | "denied") {
    const reason = decisionNotes[request.id]?.trim() ?? "";
    if (decision === "denied" && !reason) {
      setError("Add a decision note before denying this permission.");
      return;
    }
    setWorkingId(request.id);
    setError("");
    try {
      await decidePermissionRequest(
        request.id,
        decision,
        reason,
        decision === "approved" ? (validForMinutes[request.id] ?? 60) : undefined
      );
    } finally {
      setWorkingId(null);
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

      {pendingRequests.length ? (
        <ul className="alert-list-container pending-decision-list">
          {pendingRequests.map((request) => {
            const busy = workingId === request.id;
            return (
              <li key={request.id}>
                <article className="pending-decision-card">
                  <span className="pending-decision-icon" aria-hidden="true">
                    <Clock3 size={17} strokeWidth={1.8} />
                  </span>
                  <div className="alert-item-main">
                    <span className="alert-item-title">{request.subjectName}</span>
                    {request.operatorNote ? <span className="pending-decision-request-note">{request.operatorNote}</span> : null}
                    <label className="pending-decision-note">
                      <span>Decision note <em>Required to deny</em></span>
                      <textarea
                        value={decisionNotes[request.id] ?? ""}
                        disabled={busy}
                        maxLength={1000}
                        placeholder="Add a note if you deny this permission."
                        onChange={(event) => setDecisionNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                      />
                    </label>
                    <div className="pending-decision-controls">
                      <label>
                        <span>Valid for</span>
                        <select
                          value={validForMinutes[request.id] ?? 60}
                          disabled={busy}
                          onChange={(event) => setValidForMinutes((current) => ({ ...current, [request.id]: Number(event.target.value) }))}
                        >
                          {VALID_FOR_OPTIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
                        </select>
                      </label>
                      <span className="pending-decision-actions">
                        <button
                          type="button"
                          className="pending-decision-approve"
                          aria-label={`Allow ${request.subjectName}`}
                          title="Allow"
                          disabled={busy}
                          onClick={() => void decide(request, "approved")}
                        >
                          <Check size={16} strokeWidth={2.2} />
                          <span>Allow</span>
                        </button>
                        <button
                          type="button"
                          className="pending-decision-deny"
                          aria-label={`Deny ${request.subjectName}`}
                          title="Deny"
                          disabled={busy || !decisionNotes[request.id]?.trim()}
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
