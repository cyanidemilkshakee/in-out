import type { Alert } from "./types";

/** Delayed scan/evaluation events must not reopen reviewed or reset warnings. */
export function mergeAlerts(current: Alert[], updates: Alert[]): Alert[] {
  const result = new Map(current.map(alert => [alert.id, alert]));
  for (const incoming of updates) {
    const previous = result.get(incoming.id);
    if (previous?.review && (!incoming.review || incoming.review.reviewedAt < previous.review.reviewedAt)) continue;
    if (previous?.warningResetAt && (!incoming.warningResetAt || incoming.warningResetAt < previous.warningResetAt)) continue;
    result.set(incoming.id, incoming);
  }
  return [...result.values()];
}
