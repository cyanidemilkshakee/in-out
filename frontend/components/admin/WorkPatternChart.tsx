import { useMemo } from "react";
import { MONTH_NAMES, type DayPattern } from "../../../lib/analyticsUtils";

interface WorkPatternChartProps {
  timeRange?: string;
  sessions: DayPattern[];
}

type WorkPatternRow = Pick<DayPattern, "dateStr" | "percentage" | "sessions" | "workedHours">;

export function WorkPatternChart({
  timeRange = "1W",
  sessions,
}: WorkPatternChartProps) {
  const days = useMemo(() => {
    const filtered: WorkPatternRow[] = [];
    const today = new Date();
    const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const sessionsByDay = new Map(
      sessions.map((session) => [dayKey(session.dateObj), session])
    );

    const rangeDays = timeRange === "1Y" ? 365 : timeRange === "1M" ? 30 : 7;
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const session = sessionsByDay.get(dayKey(d));
      filtered.push(session ?? {
        dateStr: `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`,
        workedHours: 0,
        percentage: 0,
        sessions: []
      });
    }
    
    return filtered;
  }, [sessions, timeRange]);

  const startAxis = 0;
  const endAxis = 24;
  const totalAxisHours = endAxis - startAxis;
  const axisTicks = Array.from({ length: totalAxisHours + 1 }, (_, hour) => hour);

  return (
    <div className="employee-profile-work-pattern" style={{
      width: "100%",
      fontFamily: "var(--admin-font)",
      color: "var(--ui-text-primary)"
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", paddingBottom: "16px" }}>
        <div>
          <h2 className="employee-profile-work-pattern-title" style={{ fontWeight: "var(--weight-bold)", margin: "0 0 4px 0", color: "var(--ui-text-primary)" }}>Work Pattern</h2>
        </div>
      </div>

      {/* Chart Grid */}
      <div style={{ display: "flex", width: "100%", minWidth: 0, overflowX: "hidden" }}>
        {/* Left Axis - Dates */}
        <div style={{ width: "100px", flexShrink: 0, paddingRight: "12px", position: "relative" }}>
          {/* Header empty space - absolute positioned to stay at top when scrolling */}
          <div style={{ height: "30px", position: "sticky", top: 0, background: "var(--admin-bg)", zIndex: 5 }}></div>
          {/* Date Rows */}
          {days.map((day, i) => (
            <div key={i} style={{
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              color: "var(--ui-text-primary)"
            }}>
              <span style={{ fontWeight: "var(--weight-semibold)" }}>{day.dateStr}</span>
              <span style={{ color: "var(--admin-muted)" }}>{day.percentage}%</span>
            </div>
          ))}
        </div>

        {/* Right Axis - Timelines */}
        <div style={{ flex: "1 1 auto", minWidth: 0, position: "relative" }}>
          {/* Header Time Axis - sticky to stay at top */}
          <div style={{
            height: "30px",
            display: "flex",
            position: "sticky",
            top: 0,
            background: "var(--admin-bg)",
            zIndex: 5,
          }}>
            {axisTicks.map((hour) => (
              <div key={hour} className="employee-profile-hour-label" data-hour={hour} data-major={hour % 6 === 0} style={{
                position: "absolute",
                left: `${(hour / totalAxisHours) * 100}%`,
                top: 0,
                bottom: 0,
                transform: hour === startAxis ? "none" : hour === endAxis ? "translateX(-100%)" : "translateX(-50%)",
                paddingTop: "6px",
                color: "var(--ui-text-secondary)",
                fontWeight: "var(--weight-semibold)"
              }}>
                {hour.toString().padStart(2, '0')}
              </div>
            ))}
          </div>

          {/* Timeline Rows */}
          <div style={{ position: "relative" }}>
            {/* Background Grid Lines */}
            {axisTicks.map((hour) => (
              <div key={`grid-${hour}`} style={{
                position: "absolute",
                left: `${(hour / totalAxisHours) * 100}%`,
                top: 0,
                bottom: 0,
                borderLeft: "1px dashed var(--admin-line)",
                opacity: 0.9,
                zIndex: 0
              }} />
            ))}

            {days.map((day, i) => (
              <div key={i} style={{
                height: "28px",
                position: "relative",
              }}>
                {day.sessions.map((session, j) => {
                  const clippedStart = Math.max(startAxis, Math.min(endAxis, session.start));
                  const clippedEnd = Math.max(startAxis, Math.min(endAxis, session.end));
                  if (clippedEnd <= clippedStart) return null;
                  const left = ((clippedStart - startAxis) / totalAxisHours) * 100;
                  const width = ((clippedEnd - clippedStart) / totalAxisHours) * 100;

                  return (
                    <div key={j} style={{
                      position: "absolute",
                      left: `${left}%`,
                      width: `${width}%`,
                      top: "4px",
                      bottom: "4px",
                      background: session.type === "work" ? "#ea580c" : "var(--admin-line)",
                      borderRadius: "var(--radius)",
                      zIndex: session.zIndex,
                      opacity: 0.9
                    }} />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={{
        display: "flex",
        gap: "24px",
        padding: "16px 0 0 0",
        color: "var(--ui-text-secondary)",
        fontWeight: "var(--weight-semibold)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "#ea580c", borderRadius: "var(--radius)" }} />
          Work session
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "var(--admin-line)", borderRadius: "var(--radius)" }} />
          Break (between sessions)
        </div>
      </div>
    </div>
  );
}
