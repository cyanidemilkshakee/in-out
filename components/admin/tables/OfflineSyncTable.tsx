import { useState } from 'react';
import { ResultPill, SyncPill } from '../../StatusPill';
import type { MovementEvent } from '../../../lib/types';

export function OfflineSyncTable({
  events,
  onResolveConflicts,
  onSync
}: {
  events: MovementEvent[];
  onResolveConflicts: (eventIds: string[]) => void;
  onSync: (eventIds?: string[]) => void;
}) {
  const queued = events.filter((event) => event.syncState !== "synced");
  const queuedIds = queued.filter((event) => event.syncState === "queued").map((event) => event.id);
  const conflictIds = queued.filter((event) => event.syncState === "conflict").map((event) => event.id);
  const [selectedIds, setSelectedIds] = useState<string[]>(queuedIds);
  const selectedQueued = selectedIds.filter((id) => queuedIds.includes(id));
  const selectedConflicts = selectedIds.filter((id) => conflictIds.includes(id));

  function toggleSelected(eventId: string) {
    setSelectedIds((current) =>
      current.includes(eventId) ? current.filter((id) => id !== eventId) : [...current, eventId]
    );
  }

  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Offline Sync</h1>
          <p>Queued and conflict events created while scanner terminals are offline.</p>
        </div>
        <div className="toolbar">
          <button
            className="primary-button"
            type="button"
            disabled={!selectedQueued.length}
            onClick={() => onSync(selectedQueued)}
          >
            Sync Selected
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedConflicts.length}
            onClick={() => onResolveConflicts(selectedConflicts)}
          >
            Resolve Conflicts
          </button>
        </div>
      </div>
      <div className="sync-guidance" role="note">
        <strong>Retry guidance:</strong> queued success and manual-review events can sync automatically. Denied,
        expired, duplicate, or restricted events move to conflict review so an operator can reconcile the record.
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Select</th>
              <th>Event</th>
              <th>Subject</th>
              <th>Checkpoint</th>
              <th>Result</th>
              <th>Reason</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {queued.map((event) => (
              <tr key={event.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(event.id)}
                    onChange={() => toggleSelected(event.id)}
                    aria-label={`Select sync event ${event.id}`}
                  />
                </td>
                <td>{event.id}</td>
                <td>{event.subjectName}</td>
                <td>{event.checkpoint}</td>
                <td>
                  <ResultPill value={event.result} />
                </td>
                <td>{event.reason}</td>
                <td>
                  <SyncPill value={event.syncState} />
                </td>
              </tr>
            ))}
            {queued.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-table-cell">
                  <div className="empty-state compact-empty">
                    <strong>No offline events are waiting.</strong>
                    <span>New queued scans will appear here when terminals reconnect.</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
