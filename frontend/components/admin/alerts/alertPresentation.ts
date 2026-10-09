import type { Alert } from "../../../../lib/types";

export type AlertReviewFilter = "needs_review" | "confirmed" | "excused" | "all";

export function getAlertReviewState(alert: Alert): Exclude<AlertReviewFilter, "all"> {
  if (alert.review) return alert.review.decision;
  if (alert.status === "warned") return "confirmed";
  if (alert.status === "resolved") return "excused";
  return "needs_review";
}

export function alertTimestamp(alert: Alert) {
  const value = alert.createdAt ? new Date(alert.createdAt).getTime() : new Date(`${alert.date} ${alert.time}`).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function formatAlertReviewDate(value?: string) {
  if (!value) return "";
  const local = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}+05:30`;
  const timestamp = new Date(local);
  if (!Number.isFinite(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(timestamp);
}

export function formatAlertExplanation(alert: Pick<Alert, "explanation" | "reason">) {
  return (alert.explanation || alert.reason).replace("6:00 PM IST attendance cutoff", "6:00 PM attendance cutoff");
}

export function getAlertWarningLevel(severity: Alert["severity"]): 1 | 2 | 3 {
  switch (severity) {
    case "critical":
      return 3;
    case "high":
      return 2;
    default:
      return 1;
  }
}

export function getOpenAlertWarningNumber(alert: Alert): number {
  const warningCount = alert.warningCount ?? 0;
  const confirmedCount = Number.isSafeInteger(warningCount) && warningCount > 0 ? warningCount : 0;
  return confirmedCount + 1;
}
