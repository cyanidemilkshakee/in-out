"use client";

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw
} from "lucide-react";
import type { ScanDecision } from "../../../lib/types";

export function DecisionPanel({ decision, onManualReview }: { decision: ScanDecision, onManualReview: () => void }) {
  const { event } = decision;
  const approved = event.result === "approved";
  const manual = false;
  const title = approved
    ? `${event.direction.toUpperCase()} ALLOWED`
    : "ACCESS DENIED";

  let decisionClass = "decisionApproved";
  if (!approved && !manual) decisionClass = "decisionDenied";
  if (manual) decisionClass = "decisionManual";

  return (
    <section className={`${"decisionPanel"} ${decisionClass}`} aria-live="polite">
      <div className="decisionBanner">
        <div className="decisionIcon">
          {approved ? (
            <CheckCircle2 />
          ) : manual ? (
            <AlertTriangle />
          ) : (
            <XCircle />
          )}
        </div>
        <div className="decisionText">
          <span>Scan Decision</span>
          <h2>{title}</h2>
          <p>{event.reason === "-" ? "Auto-determined by checkpoint rule" : event.reason}</p>
        </div>
      </div>
      
      <div className="decisionFacts">
        <div>
          <span>Direction</span>
          <strong>{event.direction}</strong>
        </div>
        <div>
          <span>Time</span>
          <strong>{event.time}</strong>
        </div>
        <div>
          <span>Ref ID</span>
          <strong>{event.id}</strong>
        </div>
        <div>
          <span>Sync</span>
          <strong>{event.syncState}</strong>
        </div>
      </div>
      
      <p className="operatorGuidance">
        {approved
          ? "Proceed after visually confirming the subject and any carried hardware."
          : manual
            ? "Hold the subject at the checkpoint and document the reason before handoff."
            : "Do not permit movement. Confirm identity, checkpoint rules, and escalate if the subject disputes the result."}
      </p>

      {/* Put actions inside the panel now instead of standalone */}
      <div style={{ padding: '16px 24px', background: 'rgba(0,0,0,0.03)', display: 'flex', gap: '16px' }}>
        <button 
          onClick={onManualReview}
          style={{ 
            display: 'flex', alignItems: 'center', gap: '8px', 
            background: 'var(--surface-soft)', color: 'var(--text)', border: '1px solid var(--border)',
            padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600
          }}>
          <RefreshCw size={16} />
          Send to Manual Review
        </button>
      </div>
    </section>
  );
}
