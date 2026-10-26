import type { Person } from "./types";

export const PERSON_STATUS_LABELS: Record<Person["status"], string> = {
  active: "Active",
  inactive: "Inactive",
  pre_approved: "Pre-approved",
  pending_approval: "Pending approval",
  restricted: "Restricted",
  expired: "Expired",
};
