import type { Person } from "../../../lib/types";
import { PERSON_STATUS_LABELS } from "../../../lib/personStatus";

export function PersonStatusLabel({ status }: { status?: Person["status"] }) {
  if (!status) return null;
  const isActive = status === "active" || status === "pre_approved";
  return (
    <span className={`registry-presence employee-status-label ${isActive ? "is-inside" : "is-outside"}`}>
      {PERSON_STATUS_LABELS[status]}
    </span>
  );
}
