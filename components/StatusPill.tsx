import type { ResultStatus } from "../lib/types";

export function ResultPill({ value }: { value: ResultStatus }) {
  return <span className={`pill result-${value}`}>{value === "approved" ? "Approved" : "Denied"}</span>;
}
