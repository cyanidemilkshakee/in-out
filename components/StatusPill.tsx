import type { ResultStatus, SyncState } from "../lib/types";

type ResultPillProps = {
  value: ResultStatus;
};

export function ResultPill({ value }: ResultPillProps) {
  const labels: Record<ResultStatus, string> = {
    approved: "Approved",
    denied: "Denied"
  };

  const colors: Record<ResultStatus, "green" | "red"> = {
    approved: "green",
    denied: "red"
  };

  return <span className={`pill result-${value}`}>{labels[value]}</span>;
}

type SyncPillProps = {
  value: SyncState;
};

export function SyncPill({ value }: SyncPillProps) {
  const labels: Record<SyncState, string> = {
    synced: "Synced",
    queued: "Queued",
    conflict: "Conflict"
  };

  return (
    <span className={`sync-pill sync-${value}`} aria-label={`Sync state: ${labels[value]}`}>
      <span className="sync-dot" aria-hidden="true" />
      <span>{labels[value]}</span>
    </span>
  );
}
