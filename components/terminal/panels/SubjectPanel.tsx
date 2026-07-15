"use client";

import {
  AlertTriangle,
  Clock3,
  Laptop,
} from "lucide-react";
import type { HardwareAsset, MovementEvent, Person, SubjectRecord } from "../../../lib/types";

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
