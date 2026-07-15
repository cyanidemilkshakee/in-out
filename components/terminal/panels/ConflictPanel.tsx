"use client";

import type { MovementEvent } from "../../../lib/types";

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
