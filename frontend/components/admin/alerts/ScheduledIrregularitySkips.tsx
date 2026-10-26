"use client";

import type { AlertRuleAssignment } from "../../../../lib/types";
import { useId } from "react";
import { formatIrregularitySkipDate, irregularitySkipDateRange } from "../../../../lib/irregularitySkipDates";
import styles from "./EmployeeAlertManagement.module.css";

export function ScheduledIrregularitySkips({ assignments, variant = "default" }: { assignments: AlertRuleAssignment[]; variant?: "default" | "profile" }) {
  const titleId = useId();
  const { today, max } = irregularitySkipDateRange();
  const scheduled = assignments
    .filter((item) => item.subjectType === "employee")
    .map((item) => ({
      ...item,
      dates: (item.irregularitySkipDates ?? []).filter((date) => date >= today && date <= max).sort(),
    }))
    .filter((item) => item.dates.length > 0)
    .sort((left, right) => left.subjectName.localeCompare(right.subjectName));

  return <section className={`${styles.skipSchedule} ${variant === "profile" ? styles.skipScheduleProfile : ""}`} aria-labelledby={titleId}>
    <header className={styles.skipScheduleHeading}>
      <h3 id={titleId}>Scheduled irregularity skips</h3>
      {variant === "default" ? <span>Next six months</span> : null}
    </header>
    {scheduled.length ? <ul className={`${styles.skipScheduleList} scrollable-content`}>
      {scheduled.map((item) => <li key={item.subjectId}>
        {variant === "default" ? <strong>{item.subjectName}</strong> : null}
        <div className={styles.skipScheduleDates}>{item.dates.map((date) => <time key={date} dateTime={date}>{formatIrregularitySkipDate(date)}</time>)}</div>
      </li>)}
    </ul> : <p className={styles.skipScheduleEmpty}>{variant === "profile" ? "No irregularity skips scheduled." : "No leave dates scheduled in the next six months."}</p>}
  </section>;
}
