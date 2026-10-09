import type { AccessPermission, PermissionRequest } from "../../../../lib/types";

export const REQUEST_LABELS: Record<PermissionRequest["type"], string> = {
  visitor: "Visitor access",
  hardware_custody: "Hardware custody",
  zone_access: "Zone access",
  manual_override: "Manual review",
};

export function requestApprovalLabel(request: PermissionRequest) {
  if (request.type === "hardware_custody") return "Approve reassignment";
  if (request.type === "manual_override") return "Approve movement";
  if (request.type === "zone_access") return "Replace access";
  return "Approve access";
}

export function formatRequestDate(value?: string) {
  if (!value) return "Not set";
  const local = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const parsed = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(local) ? local : `${local}+05:30`);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(parsed);
}

export function permissionWindowLabels(validFrom?: string, validTo?: string) {
  return {
    start: validFrom ? `Starts ${formatRequestDate(validFrom)}` : "Starts immediately",
    end: validTo ? `Ends ${formatRequestDate(validTo)}` : "No end date",
  };
}

export function permissionDisplayState(permission: AccessPermission): AccessPermission["state"] {
  return permission.entryRestriction?.active ? "restricted" : permission.state;
}

export function facilityDateInput(date: Date) {
  return new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 16);
}

export function facilityDateIso(value: string) {
  return `${value}:00+05:30`;
}
