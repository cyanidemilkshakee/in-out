"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Laptop,
  XCircle,
  RefreshCw
} from "lucide-react";
import { ResultPill } from "../StatusPill";
import type { HardwareAsset, MovementEvent, Person, ScanDecision, SubjectRecord } from "../../lib/types";

function isHardware(subject: SubjectRecord | undefined): subject is HardwareAsset {
  return Boolean(subject && "category" in subject);
}

function initials(name: string) {
  return name
    .split(" ")
    .map((piece) => piece[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function DecisionPanel({ decision, onManualReview }: { decision: ScanDecision, onManualReview: () => void }) {
  const { event } = decision;
  const success = event.result === "success";
  const manual = event.result === "manual_review" || event.result === "pending";
  const title = success
    ? `${event.direction.toUpperCase()} ALLOWED`
    : event.result === "duplicate"
      ? "DUPLICATE SCAN"
      : event.result === "expired"
        ? "BARCODE EXPIRED"
        : event.result === "restricted"
          ? "RESTRICTED MOVEMENT"
          : manual
            ? "MANUAL REVIEW"
            : "ACCESS DENIED";

  let decisionClass = "decisionSuccess";
  if (!success && !manual) decisionClass = "decisionDenied";
  if (manual) decisionClass = "decisionManual";

  return (
    <section className={`${"decisionPanel"} ${decisionClass}`} aria-live="polite">
      <div className="decisionBanner">
        <div className="decisionIcon">
          {success ? (
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
        {success
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

export function RecentScansTimeline({ events }: { events: MovementEvent[] }) {
  return (
    <section className="timeline" aria-label="Recent scans timeline">
      <h3>Live Feed</h3>
      <div className="timelineList">
        {events.slice(0, 5).map((event) => (
          <div key={event.id} className="timelineItem">
            <span className="timelineTime">{event.time}</span>
            <span className="timelineName">{event.subjectName}</span>
            <ResultPill value={event.result} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SubjectPanel({
  subject,
  lastMovement
}: {
  subject?: SubjectRecord;
  lastMovement?: MovementEvent;
}) {
  if (!subject) {
    return (
      <div className="subjectCard">
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--muted)' }}>
          <AlertTriangle size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
          <strong style={{ display: 'block', fontSize: '18px', color: 'var(--text)', marginBottom: '8px' }}>Unknown barcode</strong>
          <span>No matching employee, visitor, or hardware record was found.</span>
        </div>
      </div>
    );
  }

  const hardware = isHardware(subject);
  const person = hardware ? undefined : (subject as Person);
  const label = hardware ? "Hardware" : subject.type === "visitor" ? "Visitor" : "Employee";

  return (
    <div className="subjectCard">
      <div className="subjectHeader">
        <div className="subjectAvatar">{hardware ? <Laptop /> : initials(subject.name)}</div>
        <div className="subjectInfo">
          <h3>{subject.name}</h3>
          <span className="badge">{label}</span>
        </div>
      </div>
      <div className="subjectGrid">
        <div>
          <span>{hardware ? "Asset ID" : "Barcode"}</span>
          <strong>{subject.barcode}</strong>
        </div>
        <div>
          <span>{hardware ? "Owner" : "Access Level"}</span>
          <strong>{hardware ? subject.owner : person?.accessLevel}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{subject.status}</strong>
        </div>
        <div>
          <span>Presence</span>
          <strong>{subject.inside ? "Inside" : "Outside"}</strong>
        </div>
      </div>
      <div style={{ padding: '20px', background: 'rgba(0,0,0,0.02)', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <span style={{ fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 700, display: 'block', marginBottom: '4px' }}>Last Movement</span>
            <strong style={{ fontSize: '14px', color: 'var(--text)' }}>{lastMovement?.checkpoint ?? "No movement yet"}</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--muted)', fontSize: '13px' }}>
            <Clock3 size={16} />
            <span>{lastMovement ? `${lastMovement.time} / ${lastMovement.direction}` : "Waiting"}</span>
          </div>
        </div>
      </div>
      {!hardware && subject.type === "visitor" ? (
        <div style={{ padding: '16px 20px', background: 'var(--blue-soft)', color: 'var(--blue)', fontSize: '13px' }}>
          <strong style={{ display: 'block', marginBottom: '4px' }}>Temporary barcode: {person?.validFrom} to {person?.validTo}</strong>
          <span>Host: {person?.host} / Purpose: {person?.purpose}</span>
        </div>
      ) : null}
    </div>
  );
}

export function HardwarePicker({
  assets,
  selectedHardware,
  onToggle
}: {
  assets: HardwareAsset[];
  selectedHardware: string[];
  onToggle: (assetId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {assets.map((asset) => (
        <label key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', background: 'var(--surface-soft)', border: '1px solid var(--border)', borderRadius: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={selectedHardware.includes(asset.id)}
            onChange={() => onToggle(asset.id)}
            style={{ width: '20px', height: '20px', accentColor: 'var(--blue)' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <strong style={{ color: 'var(--text)', fontSize: '15px' }}>{asset.name}</strong>
            <small style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'monospace' }}>{asset.barcode} / {asset.owner}</small>
          </div>
          <em style={{ fontStyle: 'normal', fontSize: '12px', padding: '4px 8px', background: 'rgba(0,0,0,0.05)', borderRadius: '999px', color: 'var(--text)' }}>{asset.status}</em>
        </label>
      ))}
    </div>
  );
}

export function ActivityPanel({ events }: { events: MovementEvent[] }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ padding: '12px 16px', color: 'var(--muted)', fontWeight: 600 }}>Time</th>
            <th style={{ padding: '12px 16px', color: 'var(--muted)', fontWeight: 600 }}>Subject</th>
            <th style={{ padding: '12px 16px', color: 'var(--muted)', fontWeight: 600 }}>Result</th>
          </tr>
        </thead>
        <tbody>
          {events.slice(0, 8).map((event) => (
            <tr key={event.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
              <td style={{ padding: '12px 16px', color: 'var(--muted)', fontFamily: 'monospace' }}>{event.time}</td>
              <td style={{ padding: '12px 16px', color: 'var(--text)', fontWeight: 500 }}>{event.subjectName}</td>
              <td style={{ padding: '12px 16px' }}>
                <ResultPill value={event.result} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QueuePanel({
  events,
  online,
  onSync
}: {
  events: MovementEvent[];
  online: boolean;
  onSync: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <button 
        disabled={!online || events.length === 0} 
        type="button" 
        onClick={onSync}
        style={{ width: '100%', padding: '16px', background: online ? 'var(--blue)' : 'var(--surface-soft)', color: online ? '#fff' : 'var(--muted)', border: 'none', borderRadius: '12px', fontWeight: 700, cursor: online ? 'pointer' : 'not-allowed' }}
      >
        {online ? "Sync Queue Now" : "Reconnect to Sync"}
      </button>
      
      {!online ? (
        <p style={{ color: 'var(--red)', fontSize: '13px', background: 'var(--red-soft)', padding: '12px', borderRadius: '8px' }}>Terminal is offline. Reconnect network, then retry the queue.</p>
      ) : null}
      
      {events.map((event) => (
        <div key={event.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          <strong style={{ color: 'var(--text)', fontSize: '14px' }}>{event.subjectName}</strong>
          <span style={{ color: 'var(--muted)', fontSize: '13px' }}>{event.checkpoint} / {event.result}</span>
        </div>
      ))}
      {events.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>No offline scans waiting.</p> : null}
    </div>
  );
}

export function ConflictPanel({ events }: { events: MovementEvent[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {events.length ? (
        <p style={{ color: 'var(--amber)', fontSize: '13px', background: 'var(--amber-soft)', padding: '12px', borderRadius: '8px' }}>
          Conflicts need operator review before records are considered final. Compare the checkpoint log with the
          subject status before resolving.
        </p>
      ) : null}
      {events.map((event) => (
        <div key={event.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '16px', background: 'var(--red-soft)', border: '1px solid rgba(217,45,32,0.2)', borderRadius: '12px' }}>
          <strong style={{ color: 'var(--text)', fontSize: '14px' }}>{event.subjectName}</strong>
          <span style={{ color: 'var(--red)', fontSize: '13px' }}>{event.reason}</span>
        </div>
      ))}
      {events.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>No sync conflicts.</p> : null}
    </div>
  );
}
