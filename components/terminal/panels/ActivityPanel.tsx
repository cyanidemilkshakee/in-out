"use client";

import { ResultPill } from "../../StatusPill";
import type { MovementEvent } from "../../../lib/types";

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
