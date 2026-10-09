export const MANUAL_REVIEW_DURATIONS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
] as const;

export const DEFAULT_MANUAL_REVIEW_MINUTES = 60;

export function isManualReviewDuration(value: unknown): value is number {
  return typeof value === "number" && MANUAL_REVIEW_DURATIONS.some((option) => option.minutes === value);
}
