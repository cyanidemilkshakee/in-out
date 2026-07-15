import { useMemo } from "react";
import { getPersonSessions, DayPattern } from "../../lib/analyticsUtils";
import type { MovementEvent } from "../../lib/types";

interface WorkPatternChartProps {
  personId: string;
  timeRange?: string;
  movements: MovementEvent[];
}

type WorkPatternRow = Pick<DayPattern, "dateStr" | "percentage" | "sessions" | "workedHours">;

export function WorkPatternChart({ personId, timeRange = "1W", movements }: WorkPatternChartProps) {
  const days = useMemo(() => {
    const allSessions = getPersonSessions(personId, movements);
    const filtered: WorkPatternRow[] = [];
    const today = new Date();
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const sessionsByDay = new Map(allSessions.map((session) => [dayKey(session.dateObj), session]));

    const rangeDays = timeRange === "1Y" ? 365 : timeRange === "1M" ? 30 : 7;
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const session = sessionsByDay.get(dayKey(d));
      filtered.push(session ?? {
        dateStr: `${d.getDate()} ${monthNames[d.getMonth()]}`,
        workedHours: 0,
        percentage: 0,
        sessions: []
      });
    }
    
    return filtered;
  }, [movements, personId, timeRange]);

  const startAxis = 6;
  const endAxis = 22;
  const totalAxisHours = endAxis - startAxis;

  return (
    <div style={{
      width: "100%",
      fontSize: "12px",
      fontFamily: "var(--admin-font)",
      color: "var(--admin-text)"
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", paddingBottom: "16px" }}>
        <div>
          <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px 0", color: "var(--admin-text)" }}>Work Pattern</h2>
        </div>
      </div>

      {/* Chart Grid */}
      <div style={{ display: "flex", width: "100%", maxHeight: "300px", overflowY: "auto", overflowX: "hidden" }}>
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
              color: "var(--admin-text)"
            }}>
              <span style={{ fontWeight: 600 }}>{day.dateStr}</span>
              <span style={{ color: "var(--admin-muted)", fontSize: "10px" }}>{day.percentage}%</span>
            </div>
          ))}
        </div>

        {/* Right Axis - Timelines */}
        <div style={{ flexGrow: 1, position: "relative" }}>
          {/* Header Time Axis - sticky to stay at top */}
          <div style={{
            height: "30px",
            display: "flex",
            position: "sticky",
            top: 0,
            background: "var(--admin-bg)",
            zIndex: 5,
          }}>
            {Array.from({ length: totalAxisHours + 1 }).map((_, i) => (
              <div key={i} style={{
                position: "absolute",
                left: `${(i / totalAxisHours) * 100}%`,
                top: 0,
                bottom: 0,
                display: "flex",
                alignItems: "center",
                transform: "translateX(-50%)",
                paddingTop: "6px",
                color: "var(--admin-muted)",
                fontSize: "11px",
                fontWeight: 600
              }}>
                {(startAxis + i).toString().padStart(2, '0')}
              </div>
            ))}
          </div>

          {/* Timeline Rows */}
          <div style={{ position: "relative" }}>
            {/* Background Grid Lines */}
            {Array.from({ length: totalAxisHours + 1 }).map((_, i) => (
              <div key={`grid-${i}`} style={{
                position: "absolute",
                left: `${(i / totalAxisHours) * 100}%`,
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
                  const left = ((session.start - startAxis) / totalAxisHours) * 100;
                  const width = ((session.end - session.start) / totalAxisHours) * 100;
                  
                  return (
                    <div key={j} style={{
                      position: "absolute",
                      left: `${Math.max(0, left)}%`,
                      width: `${Math.min(100 - left, width)}%`,
                      top: "4px",
                      bottom: "4px",
                      background: session.type === "work" ? "#ea580c" : "var(--admin-line)",
                      borderRadius: "2px",
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
        color: "var(--admin-muted)",
        fontWeight: 600
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "#ea580c", borderRadius: "2px" }} />
          Work session
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "var(--admin-line)", borderRadius: "2px" }} />
          Break (between sessions)
        </div>
      </div>
    </div>
  );
}
