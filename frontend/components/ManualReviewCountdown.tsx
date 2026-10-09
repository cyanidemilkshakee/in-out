"use client";

import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import {
  formatManualReviewCountdown,
  getManualReviewSecondsRemaining,
  MANUAL_REVIEW_TIMEOUT_MINUTES,
} from "../../lib/manualReviewTimeout";
import styles from "./ManualReviewCountdown.module.css";

export function ManualReviewCountdown({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = now === null ? null : getManualReviewSecondsRemaining(createdAt, now);
  const expired = remaining === 0;
  const label = remaining === null
    ? "Review timeout"
    : remaining > 0
      ? `Time remaining ${formatManualReviewCountdown(remaining)}`
      : "Timeout reached";

  return (
    <span
      className={styles.countdown}
      data-expired={expired ? "true" : undefined}
      title={`Manual reviews are auto-denied after ${MANUAL_REVIEW_TIMEOUT_MINUTES} minutes.`}
      aria-label={label}
    >
      <Clock3 size={13} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}
