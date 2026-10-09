"use client";

import type { AlertRuleAssignment } from "../../../../lib/types";
import { formatIrregularitySkipDate, irregularitySkipDateRange } from "../../../../lib/irregularitySkipDates";
import styles from "./EmployeeAlertManagement.module.css";

export function ScheduledIrregularitySkips({ assignments }: { assignments: AlertRuleAssignment[] }) {
  const { today, max } = irregularitySkipDateRange();
  const scheduled = assignments
    .filter((item) => item.subjectType === "employee")
    .map((item) => ({
      ...item,
      dates: (item.irregularitySkipDates ?? []).filter((date) => date >= today && date <= max).sort(),
    }))
    .filter((item) => item.dates.length > 0)
    .sort((left, right) => left.subjectName.localeCompare(right.subjectName));

  return <section className={styles.skipSchedule} aria-labelledby="scheduled-irregularity-skips-title">
    <header className={styles.skipScheduleHeading}>
      <h3 id="scheduled-irregularity-skips-title">Scheduled irregularity skips</h3>
      <span>Next six months</span>
    </header>
    {scheduled.length ? <ul className={styles.skipScheduleList}>
      {scheduled.map((item) => <li key={item.subjectId}>
        <strong>{item.subjectName}</strong>
        <div className={styles.skipScheduleDates}>{item.dates.map((date) => <time key={date} dateTime={date}>{formatIrregularitySkipDate(date)}</time>)}</div>
      </li>)}
    </ul> : <p className={styles.skipScheduleEmpty}>No leave dates scheduled in the next six months.</p>}
  </section>;
}
