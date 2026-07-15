import { useState, type FormEvent } from 'react';
import { BadgePlus, X } from 'lucide-react';
import type { CreateTemporaryVisitorInput } from '../../../services/dataService';

export function TemporaryVisitorCreator({
  onCreate,
}: {
  onCreate: (input: CreateTemporaryVisitorInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState("");
  const [hours, setHours] = useState(4);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onCreate({ name, company, host, hours });
      setName("");
      setCompany("");
      setHost("");
      setHours(4);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="temporary-id-popover">
      <button className="primary-button" type="button" onClick={() => setOpen(true)}>
        <BadgePlus />
        Create
      </button>
      {open ? (
        <div className="temporary-id-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <form
            className="temporary-id-form temporary-id-card"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={submit}
          >
            <div className="temporary-id-card-header">
              <span>
                <BadgePlus />
                <strong>Create Temporary Visitor ID</strong>
              </span>
              <button className="icon-button compact-button" type="button" onClick={() => setOpen(false)} aria-label="Close temporary visitor form">
                <X size={15} />
              </button>
            </div>
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Visitor name" autoFocus />
            </label>
            <label>
              <span>Company</span>
              <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Company or walk-in" />
            </label>
            <label>
              <span>Host</span>
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="Host employee" />
            </label>
            <label>
              <span>Hours</span>
              <input
                min={1}
                max={24}
                type="number"
                value={hours}
                onChange={(event) => setHours(Math.min(24, Math.max(1, Number(event.target.value) || 1)))}
              />
            </label>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create ID"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
