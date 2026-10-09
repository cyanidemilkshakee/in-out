export const MANUAL_REVIEW_TIMEOUT_MINUTES = 10;
export const MANUAL_REVIEW_TIMEOUT_SECONDS = MANUAL_REVIEW_TIMEOUT_MINUTES * 60;

export function getManualReviewSecondsRemaining(createdAt: string, now = Date.now()) {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;

  const deadline = createdAtMs + MANUAL_REVIEW_TIMEOUT_SECONDS * 1_000;
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

export function formatManualReviewCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
