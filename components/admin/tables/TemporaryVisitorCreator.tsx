import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { BadgePlus, X } from 'lucide-react';
import type { CreateTemporaryVisitorInput } from '../../../services/dataService';

const DEFAULT_VISIT_HOURS = 4;
const MAX_VISIT_HOURS = 24;
const HOUR_IN_MS = 60 * 60 * 1000;
const MINIMUM_VISIT_MS = 60 * 1000;

function toDateTimeLocal(date: Date) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function getMaximumEndValue(validFrom: string) {
  const start = new Date(validFrom);
  if (Number.isNaN(start.getTime())) return "";
  return toDateTimeLocal(new Date(start.getTime() + MAX_VISIT_HOURS * HOUR_IN_MS));
}

function getMinimumEndValue(validFrom: string) {
  const start = new Date(validFrom);
  if (Number.isNaN(start.getTime())) return "";
  return toDateTimeLocal(new Date(start.getTime() + MINIMUM_VISIT_MS));
}

export function TemporaryVisitorCreator({
  onCreate,
}: {
  onCreate: (input: CreateTemporaryVisitorInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState("");
  const [minimumDateTime, setMinimumDateTime] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const minimumEndValue = getMinimumEndValue(validFrom);
  const maximumEndValue = getMaximumEndValue(validFrom);

  function openForm() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 5);
    const end = new Date(start.getTime() + DEFAULT_VISIT_HOURS * HOUR_IN_MS);

    setMinimumDateTime(toDateTimeLocal(start));
    setValidFrom(toDateTimeLocal(start));
    setValidUntil(toDateTimeLocal(end));
    setFormError("");
    setOpen(true);
  }

  function updateValidFrom(value: string) {
    setValidFrom(value);
    const start = new Date(value);
    const currentEnd = new Date(validUntil);
    if (Number.isNaN(start.getTime())) return;

    const maximumEnd = start.getTime() + MAX_VISIT_HOURS * HOUR_IN_MS;
    if (
      Number.isNaN(currentEnd.getTime()) ||
      currentEnd.getTime() <= start.getTime() ||
      currentEnd.getTime() > maximumEnd
    ) {
      setValidUntil(
        toDateTimeLocal(new Date(start.getTime() + DEFAULT_VISIT_HOURS * HOUR_IN_MS))
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = new Date(validFrom);
    const end = new Date(validUntil);
    const duration = end.getTime() - start.getTime();

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setFormError("Choose a valid start and end date and time.");
      return;
    }
    if (start.getTime() < Date.now() - 60_000) {
      setFormError("The access start must be in the future.");
      return;
    }
    if (duration <= 0) {
      setFormError("The access end must be later than the start.");
      return;
    }
    if (duration > MAX_VISIT_HOURS * HOUR_IN_MS) {
      setFormError("Temporary access cannot exceed 24 hours.");
      return;
    }

    setFormError("");
    setSubmitting(true);
    try {
      await onCreate({
        name,
        company,
        host,
        hours: Math.max(1, Math.ceil(duration / HOUR_IN_MS)),
        validFrom,
        validUntil,
        reason,
      });
      setName("");
      setCompany("");
      setHost("");
      setValidFrom("");
      setValidUntil("");
      setReason("");
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="temporary-id-popover">
      <button
        className="ghost-button temporary-create-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="temporary-visitor-dialog"
        onClick={openForm}
      >
        <BadgePlus />
        Create
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="temporary-id-overlay role-admin" role="presentation" onMouseDown={() => setOpen(false)}>
          <form
            id="temporary-visitor-dialog"
            className="temporary-id-form temporary-id-card"
            role="dialog"
            aria-modal="true"
            aria-label="Create temporary visitor ID"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={submit}
          >
            <div className="temporary-id-card-header">
              <button
                className="icon-button compact-button"
                type="button"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                }}
                onClick={() => setOpen(false)}
                aria-label="Close temporary visitor form"
              >
                <X size={15} />
              </button>
            </div>
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Visitor name" required autoFocus />
            </label>
            <label>
              <span>Company</span>
              <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Company or walk-in" />
            </label>
            <label>
              <span>Host</span>
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="Host employee" required />
            </label>
            <div className="temporary-id-date-grid">
              <label>
                <span>Valid from</span>
                <input
                  type="datetime-local"
                  min={minimumDateTime}
                  value={validFrom}
                  onChange={(event) => updateValidFrom(event.target.value)}
                  required
                />
              </label>
              <label>
                <span>Valid until</span>
                <input
                  type="datetime-local"
                  min={minimumEndValue || minimumDateTime}
                  max={maximumEndValue || undefined}
                  value={validUntil}
                  onChange={(event) => setValidUntil(event.target.value)}
                  aria-describedby="temporary-visitor-date-hint"
                  required
                />
              </label>
            </div>
            <small id="temporary-visitor-date-hint" className="temporary-id-date-hint">
              Start in the future. Maximum access window: 24 hours.
            </small>
            <label>
              <span>Reason</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason for the visit"
                maxLength={240}
                required
              />
            </label>
            {formError ? <p className="temporary-id-form-error" role="alert">{formError}</p> : null}
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create ID"}
            </button>
          </form>
        </div>,
        document.body
      ) : null}
    </div>
  );
}
