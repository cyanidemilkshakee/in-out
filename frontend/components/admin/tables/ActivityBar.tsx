import type { DayPattern } from "../../../../lib/analyticsUtils";

const START_HOUR = 9;
const END_HOUR = 21;
const WINDOW_HOURS = END_HOUR - START_HOUR;

export function ActivityBar({
  sessions,
}: {
  sessions: DayPattern[];
}) {
  const latestDay = sessions[0];

  return (
    <div className="employee-activity">
      <div className="employee-activity-track">
        {latestDay?.sessions.map((session, index) => {
          const start = Math.max(START_HOUR, session.start);
          const end = Math.min(END_HOUR, session.end);
          if (end <= start) return null;
          return (
            <div
              key={`${session.type}-${index}`}
              className={`employee-activity-segment is-${session.type}`}
              style={{
                left: `${((start - START_HOUR) / WINDOW_HOURS) * 100}%`,
                width: `${((end - start) / WINDOW_HOURS) * 100}%`,
              }}
              title={`${session.type}: ${start.toFixed(1)}–${end.toFixed(1)}`}
            />
          );
        })}
      </div>
      <div className="employee-activity-labels">
        <span>9am</span>
        <span>12pm</span>
        <span>3pm</span>
        <span>6pm</span>
        <span>9pm</span>
      </div>
    </div>
  );
}
