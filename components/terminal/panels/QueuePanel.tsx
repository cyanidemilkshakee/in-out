"use client";

import type { MovementEvent } from "../../../lib/types";

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
