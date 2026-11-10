import type { Alert } from "../../../../lib/types";

export type AlertReviewFilter = "needs_review" | "confirmed" | "excused" | "acknowledged" | "all";
export type AlertGroup = { key: string; alerts: Alert[] };

export function groupAlertsBySubjectAndType(alerts: readonly Alert[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const subject = alert.subjectId
      ? `id:${alert.subjectId}`
      : alert.barcode
        ? `barcode:${alert.barcode.toLocaleLowerCase()}`
        : `checkpoint:${(alert.checkpoint || alert.subjectName || "unknown").toLocaleLowerCase()}`;
    const type = alert.conditionKey || alert.title.trim().toLocaleLowerCase() || alert.ruleId || "unknown";
    const key = JSON.stringify([subject, type]);
    const group = groups.get(key);
    if (group) group.alerts.push(alert);
    else groups.set(key, { key, alerts: [alert] });
  }
  return [...groups.values()];
}

export function alertGroupDateRange(alerts: readonly Alert[]): string {
  if (!alerts.length) return "";
  const oldest = alerts.reduce((a, b) => alertTimestamp(a) <= alertTimestamp(b) ? a : b);
  const newest = alerts.reduce((a, b) => alertTimestamp(a) >= alertTimestamp(b) ? a : b);
  const format = (alert: Alert) => `${alert.date} · ${alert.time}`;
  return oldest.id === newest.id ? format(oldest) : `${format(oldest)} – ${format(newest)}`;
}

export function getAlertWarningLevel(severity: Alert["severity"]): 1 | 2 | 3 {
  if (severity === "critical") return 3;
  if (severity === "high") return 2;
  return 1;
}

export function getAlertReviewState(alert: Alert): Exclude<AlertReviewFilter, "all"> {
  if (alert.ruleId === "rule-scan-burst" && alert.status === "acknowledged") return "acknowledged";
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
  const explanation = alert.explanation || alert.reason;
  const visitStart = /(The current visit began) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/;
  const readableExplanation = explanation.replace(visitStart, (_match, lead: string, value: string) => {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return `${lead} at ${value}`;
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata", month: "short", day: "numeric", year: "numeric",
    }).format(timestamp);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit",
    }).format(timestamp);
    return `${lead} on ${date} at ${time} IST`;
  });
  return readableExplanation.replace("6:00 PM IST attendance cutoff", "6:00 PM attendance cutoff");
}
