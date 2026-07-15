import { X } from 'lucide-react';
import type { Alert, MovementEvent } from '../../../lib/types';

export function DetailDrawer({
  alert,
  event,
  notes,
  noteDraft,
  onNoteDraftChange,
  onAcknowledge,
  onResolve,
  onAddNote,
  onClose
}: {
  alert?: Alert;
  event: MovementEvent;
  notes: string[];
  noteDraft: string;
  onNoteDraftChange: (value: string) => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onAddNote: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="detail-drawer" aria-label="Movement details">
      <div className="drawer-header">
        <h2>{event.subjectName}</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close movement details">
          <X />
        </button>
      </div>
      <section className="drawer-section">
        <dl className="detail-grid">
          <div>
            <dt>Date</dt>
            <dd>{event.date}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{event.time}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd style={{ textTransform: "capitalize" }}>{event.subjectType}</dd>
          </div>
          <div>
            <dt>Direction</dt>
            <dd style={{ textTransform: "capitalize" }}>{event.direction}</dd>
          </div>
          <div>
            <dt>Barcode</dt>
            <dd>{event.barcode}</dd>
          </div>
          <div>
            <dt>Checkpoint Name</dt>
            <dd>{event.checkpoint}</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd style={{ textTransform: "capitalize" }}>{event.result}</dd>
          </div>
          <div>
            <dt>{alert ? "Alert ID" : "Event ID"}</dt>
            <dd>{alert?.id ?? event.id}</dd>
          </div>
          <div>
            <dt>Scan Type</dt>
            <dd style={{ textTransform: "capitalize" }}>{event.scanType ?? "N/A"}</dd>
          </div>
        </dl>
      </section>
      <dl className="detail-list">
        <div>
          <dt>Reason</dt>
          <dd>{event.reason}</dd>
        </div>
      </dl>
    </aside>
  );
}
