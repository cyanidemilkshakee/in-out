import type { ResultStatus, Scanner, SyncState } from "../lib/types";

type ResultPillProps = {
  value: ResultStatus;
};

export function ResultPill({ value }: ResultPillProps) {
  const labels: Record<ResultStatus, string> = {
    success: "Success",
    denied: "Denied",
    duplicate: "Duplicate",
    expired: "Expired",
    restricted: "Restricted",
    manual_review: "Manual Review",
    pending: "Pending"
  };

  return <span className={`pill result-${value}`}>{labels[value]}</span>;
}

type SyncPillProps = {
  value: SyncState;
};

export function SyncPill({ value }: SyncPillProps) {
  return <span className={`sync-dot sync-${value}`} title={value} />;
}

type ScannerPillProps = {
  value: Scanner["status"];
};

export function ScannerPill({ value }: ScannerPillProps) {
  return <span className={`pill scanner-${value}`}>{value}</span>;
}
