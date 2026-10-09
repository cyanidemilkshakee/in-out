import type { Person } from "../../../lib/types";

export function EmployeeStatusLabel({ status }: { status?: Person["status"] }) {
  if (!status) return null;
  const isActive = status === "active";
  return (
    <span className={`registry-presence employee-status-label ${isActive ? "is-inside" : "is-outside"}`}>
      {isActive ? "Active" : "Inactive"}
    </span>
  );
}
