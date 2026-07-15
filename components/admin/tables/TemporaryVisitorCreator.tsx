import { useState, type FormEvent } from 'react';
import { BadgePlus, X } from 'lucide-react';
import type { Person } from '../../../lib/types';

export function TemporaryVisitorCreator({ onCreate }: { onCreate: (person: Person) => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState("");
  const [hours, setHours] = useState(4);
  const [open, setOpen] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const start = new Date();
    const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
    onCreate({
      id: `vis-temp-${suffix}`,
      name: name.trim() || `Temporary Visitor ${suffix}`,
      type: "visitor",
      barcode: `V-TEMP-${suffix}`,
      company: company.trim() || "Walk-in",
      phone: "+91 00000 00000",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "pre_approved",
      host: host.trim() || "Security Desk",
      purpose: "Temporary visit",
      validFrom: start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      validTo: end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      inside: false
    });
    setName("");
    setCompany("");
    setHost("");
    setHours(4);
    setOpen(false);
  }

  return (
    <div className="temporary-id-popover">
      <button className="primary-button" type="button" onClick={() => setOpen(true)}>
        <BadgePlus />
        Create
      </button>
      {open ? (
        <form className="temporary-id-form temporary-id-card" style={{ gridTemplateColumns: "1fr" }} onSubmit={submit}>
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
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Visitor name" />
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
              onChange={(event) => setHours(Number(event.target.value))}
            />
          </label>
          <button className="primary-button" type="submit">
            Create ID
          </button>
        </form>
      ) : null}
    </div>
  );
}
