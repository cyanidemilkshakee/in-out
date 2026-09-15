"use client";

import Link from "next/link";
import { Barcode, Check, ChevronRight, Clock3, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useDataActions } from "../../context/DataContext";
import type { PermissionRequest } from "../../../lib/types";

export function PendingDecisionsWidget({
  requests,
  limit = 5,
}: {
  requests: PermissionRequest[];
  limit?: number;
}) {
  const { decidePermissionRequest } = useDataActions();
  const [workingId, setWorkingId] = useState<string | null>(null);
  const pendingRequests = useMemo(
    () => requests
      .filter((request) => request.status === "pending")
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit),
    [limit, requests]
  );

  async function decide(request: PermissionRequest, decision: "approved" | "denied") {
    setWorkingId(request.id);
    try {
      await decidePermissionRequest(
        request.id,
        decision,
        decision === "approved"
          ? "Approved from Dashboard pending decisions"
          : "Denied from Dashboard pending decisions"
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
          aria-label="Open pending permission decisions"
        >
          <h2 id="pending-decisions-heading">Pending Decisions</h2>
          <ChevronRight
            className="alert-widget-title-chevron"
            aria-hidden="true"
            size={18}
          />
        </Link>
      </header>

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
                  <span className="alert-item-main">
                    <span className="alert-item-title">{request.subjectName}</span>
                    <span className="alert-item-meta">
                      <span>{request.type === "manual_override" ? "Manual review" : "Permission request"}</span>
                      <span className="pending-decision-barcode"><Barcode size={11} />{request.barcode || "Registered subject"}</span>
                    </span>
                  </span>
                  <span className="pending-decision-actions">
                    <button
                      type="button"
                      className="pending-decision-approve"
                      aria-label={`Approve ${request.subjectName}`}
                      title="Approve"
                      disabled={busy}
                      onClick={() => void decide(request, "approved")}
                    >
                      <Check size={16} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      className="pending-decision-deny"
                      aria-label={`Deny ${request.subjectName}`}
                      title="Deny"
                      disabled={busy}
                      onClick={() => void decide(request, "denied")}
                    >
                      <X size={16} strokeWidth={2.2} />
                    </button>
                  </span>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="alert-widget-empty">
          <span className="alert-widget-empty-icon" aria-hidden="true">✓</span>
          <div>
            <strong>No pending decisions</strong>
            <span>All permission requests are up to date.</span>
          </div>
        </div>
      )}

      <p className="alert-widget-count" aria-live="polite">
        {requests.filter((request) => request.status === "pending").length} pending {requests.filter((request) => request.status === "pending").length === 1 ? "decision" : "decisions"}
      </p>
    </section>
  );
}
