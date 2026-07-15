import { useMemo } from "react";
import { getPersonSessions, DayPattern } from "../../lib/analyticsUtils";

interface WorkPatternChartProps {
  personId: string;
  timeRange?: string;
}

export function WorkPatternChart({ personId, timeRange = "1W" }: WorkPatternChartProps) {
  const days = useMemo(() => {
    const allSessions = getPersonSessions(personId);
    let filtered: DayPattern[] = [];
    
    // getPersonSessions returns them sorted descending (newest first). 
    // We want chronologically ascending for the chart (oldest at top).
    // Let's reverse them after taking the slice.
    
    if (timeRange === "1W") {
      filtered = allSessions.slice(0, 7).reverse();
    } else if (timeRange === "1M") {
      filtered = allSessions.slice(0, 30).reverse();
    } else if (timeRange === "1Y") {
      // Group by month
      const monthlyData: Record<string, { totalHours: number, count: number }> = {};
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      
      for (const s of allSessions.slice(0, 365)) {
        const m = monthNames[s.dateObj.getMonth()];
        if (!monthlyData[m]) monthlyData[m] = { totalHours: 0, count: 0 };
        monthlyData[m].totalHours += s.workedHours;
        monthlyData[m].count++;
      }
      
      const result = [];
      const today = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today);
        d.setMonth(d.getMonth() - i);
        const m = monthNames[d.getMonth()];
        const stats = monthlyData[m] || { totalHours: 0, count: 1 }; // Avoid div by 0
        const avgHours = stats.count > 0 ? stats.totalHours / stats.count : 0;
        
        // Mock a typical day for that month based on the average hours
        // Say, starting at 9 AM, ending at 9 + avgHours
        const percentage = Math.round((avgHours / 8) * 100);
        result.push({
          dateStr: m,
          percentage: Math.min(percentage, 100),
          sessions: avgHours > 0 ? [{ start: 9, end: 9 + avgHours, type: "work" as const, zIndex: 1 }] : []
        });
      }
      return result;
    }
    
    return filtered;
  }, [personId, timeRange]);

  const startAxis = 6;
  const endAxis = 22;
  const totalAxisHours = endAxis - startAxis;

  return (
    <div style={{
      width: "100%",
      fontSize: "12px",
      fontFamily: "var(--admin-font)"
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", paddingBottom: "16px" }}>
        <div>
          <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px 0", color: "var(--text)" }}>Work Pattern</h2>
        </div>
      </div>

      {/* Chart Grid */}
      <div style={{ display: "flex", width: "100%", maxHeight: "300px", overflowY: "auto", overflowX: "hidden" }}>
        {/* Left Axis - Dates */}
        <div style={{ width: "100px", flexShrink: 0, paddingRight: "12px", position: "relative" }}>
          {/* Header empty space - absolute positioned to stay at top when scrolling */}
          <div style={{ height: "30px", position: "sticky", top: 0, background: "var(--bg)", zIndex: 5 }}></div>
          {/* Date Rows */}
          {days.map((day, i) => (
            <div key={i} style={{
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              color: "var(--text)"
            }}>
              <span style={{ fontWeight: 600 }}>{day.dateStr}</span>
              <span style={{ color: "var(--muted)", fontSize: "10px" }}>{day.percentage}%</span>
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
            background: "var(--bg)",
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
                color: "var(--muted)",
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
                borderLeft: "1px dashed black",
                opacity: 0.5,
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
                      background: session.type === "work" ? "#ea580c" : "#d8dde6",
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
        color: "var(--muted)",
        fontWeight: 600
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "#ea580c", borderRadius: "2px" }} />
          Work session
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: "12px", height: "12px", background: "#d8dde6", borderRadius: "2px" }} />
          Break (between sessions)
        </div>
      </div>
    </div>
  );
}
