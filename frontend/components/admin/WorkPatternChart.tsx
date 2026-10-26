import { useMemo } from "react";
import { MONTH_NAMES, type DayPattern } from "../../../lib/analyticsUtils";

interface WorkPatternChartProps {
  timeRange?: "1W" | "1M" | "1Y";
  sessions: DayPattern[];
  endAt?: string;
}

type WorkPatternRow = Pick<DayPattern, "dateStr" | "percentage" | "sessions" | "workedHours">;

export function WorkPatternChart({
  timeRange = "1W",
  sessions,
  endAt,
}: WorkPatternChartProps) {
  const days = useMemo(() => {
    const filtered: WorkPatternRow[] = [];
    const facilityDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(endAt ? new Date(endAt) : new Date());
    const today = new Date(`${facilityDate}T00:00:00Z`);
    const dayKey = (date: Date) => date.toISOString().slice(0, 10);
    const sessionsByDay = new Map(
      sessions.map((session) => [dayKey(session.dateObj), session])
    );

    const rangeDays = timeRange === "1Y" ? 365 : timeRange === "1M" ? 30 : 7;
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const session = sessionsByDay.get(dayKey(d));
      filtered.push(session ?? {
        dateStr: `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`,
        workedHours: 0,
        percentage: 0,
        sessions: []
      });
    }
    
    return filtered;
  }, [sessions, timeRange, endAt]);

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
      <div className="employee-profile-work-pattern-heading" style={{ paddingBottom: "12px" }}>
        <h2 className="employee-profile-work-pattern-title" style={{ fontWeight: "var(--weight-bold)", lineHeight: "24px", margin: 0, color: "var(--ui-text-primary)" }}>Work pattern</h2>
      </div>

      <div style={{ display: "flex", width: "100%", minWidth: 0 }}>
        <div className="employee-profile-work-pattern-dates" style={{ width: "104px", flexShrink: 0, paddingRight: "12px", position: "relative" }}>
          <div className="employee-profile-work-pattern-axis" style={{ height: "30px", position: "sticky", top: 0, background: "var(--profile-card-bg, var(--admin-panel))", zIndex: 6 }}></div>
          {days.map((day, i) => (
            <div key={i} style={{
              height: "30px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "4px",
              fontSize: "15px",
              lineHeight: "20px",
              color: "var(--ui-text-primary)"
            }}>
              <span style={{ fontWeight: "var(--weight-semibold)" }}>{day.dateStr}</span>
              <span style={{ color: "var(--admin-muted)", fontSize: "14px", fontVariantNumeric: "tabular-nums" }}>{day.percentage}%</span>
            </div>
          ))}
        </div>

        <div style={{ flex: "1 1 auto", minWidth: 0, position: "relative" }}>
          <div className="employee-profile-work-pattern-axis" style={{
            height: "30px",
            display: "flex",
            position: "sticky",
            top: 0,
            background: "var(--profile-card-bg, var(--admin-panel))",
            zIndex: 5,
          }}>
            {axisTicks.map((hour) => (
              <div key={hour} className="employee-profile-hour-label" data-hour={hour} data-major={hour % 6 === 0} data-secondary={hour % 3 === 0} style={{
                position: "absolute",
                left: `${(hour / totalAxisHours) * 100}%`,
                top: 0,
                bottom: 0,
                transform: hour === startAxis ? "none" : hour === endAxis ? "translateX(-100%)" : "translateX(-50%)",
                fontSize: "14px",
                lineHeight: "22px",
                color: "var(--ui-text-secondary)",
                fontWeight: "var(--weight-semibold)"
              }}>
                {hour.toString().padStart(2, '0')}
              </div>
            ))}
          </div>

          <div style={{ position: "relative" }}>
            {axisTicks.map((hour) => (
              <div key={`grid-${hour}`} style={{
                position: "absolute",
                left: `${(hour / totalAxisHours) * 100}%`,
                top: 0,
                bottom: 0,
                borderLeft: "1px solid var(--admin-line)",
                opacity: hour % 6 === 0 ? 0.65 : 0.25,
                zIndex: 0
              }} />
            ))}

            {days.map((day, i) => (
              <div key={i} style={{
                height: "30px",
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
                      top: "7px",
                      bottom: "7px",
                      background: session.type === "work" ? "#ea580c" : "var(--admin-line)",
                      borderRadius: "3px",
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

      <div className="employee-profile-work-pattern-legend" style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "8px 12px",
        paddingTop: "12px",
        color: "var(--ui-text-secondary)",
        fontSize: "14px",
        lineHeight: "20px",
        fontWeight: "var(--weight-semibold)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "8px", height: "8px", flexShrink: 0, background: "#ea580c", borderRadius: "3px" }} />
          Work session
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "8px", height: "8px", flexShrink: 0, background: "var(--admin-line)", borderRadius: "3px" }} />
          Break (between sessions)
        </div>
      </div>
    </div>
  );
}
