import { useState } from 'react';
import type { CreateTemporaryVisitorInput } from '../../../services/dataService';
import { CreationDialog } from './CreationDialog';

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
  isTerminal,
}: {
  onCreate: (input: CreateTemporaryVisitorInput) => Promise<unknown>;
  isTerminal?: boolean;
}) {
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [company, setCompany] = useState("");
  const [host, setHost] = useState("");
  const [minimumDateTime, setMinimumDateTime] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const minimumEndValue = getMinimumEndValue(validFrom);
  const maximumEndValue = getMaximumEndValue(validFrom);

  function openForm() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 5);
    const end = new Date(start.getTime() + DEFAULT_VISIT_HOURS * HOUR_IN_MS);

    setMinimumDateTime(toDateTimeLocal(start));
    setName("");
    setBarcode("");
    setCompany("");
    setHost("");
    setValidFrom(toDateTimeLocal(start));
    setValidUntil(toDateTimeLocal(end));
    setReason("");
    setFormError("");
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

  async function submit() {
    const start = new Date(validFrom);
    const end = new Date(validUntil);
    const duration = end.getTime() - start.getTime();

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setFormError("Choose a valid start and end date and time.");
      return false;
    }
    if (start.getTime() < Date.now() - 60_000) {
      setFormError("The access start must be in the future.");
      return false;
    }
    if (duration <= 0) {
      setFormError("The access end must be later than the start.");
      return false;
    }
    if (duration > MAX_VISIT_HOURS * HOUR_IN_MS) {
      setFormError("Temporary access cannot exceed 24 hours.");
      return false;
    }

    setFormError("");
    try {
      await onCreate({
        name,
        barcode,
        company,
        host,
        hours: Math.max(1, Math.ceil(duration / HOUR_IN_MS)),
        validFrom,
        validUntil,
        reason,
      });
      setName("");
      setBarcode("");
      setCompany("");
      setHost("");
      setValidFrom("");
      setValidUntil("");
      setReason("");
      return true;
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Unable to create the visitor ID.");
      return false;
    }
  }

  return (
    <CreationDialog
      triggerLabel="Create"
      title="Create Temporary Visitor ID"
      description="Issue a time-limited visitor identity and access window."
      submitLabel="Create ID"
      cardClassName="creation-dialog-visitor"
      triggerClassName={isTerminal ? "terminal-create-btn" : undefined}
      error={formError}
      onOpen={openForm}
      onSubmit={submit}
    >
      <div className="creation-dialog-grid creation-dialog-grid-two">
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => { setName(event.target.value); setFormError(""); }} placeholder="Visitor name" required autoFocus />
        </label>
        <label>
          <span>Barcode</span>
          <input value={barcode} onChange={(event) => { setBarcode(event.target.value); setFormError(""); }} placeholder="Visitor barcode" required />
        </label>
        <label>
          <span>Company</span>
          <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Company or walk-in" />
        </label>
        <label>
          <span>Host</span>
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="Host employee" required />
        </label>
      </div>
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
    </CreationDialog>
  );
}
