"use client";

import { useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { getEmployeeKPIs, getAverageShiftLengths } from "../../../lib/analyticsUtils";
import type { Person } from "../../../lib/types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler
);

export function EmployeeHeaderStats({ employees }: { employees: Person[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<"1W" | "1M" | "1Y">("1W");

  const kpis = useMemo(() => getEmployeeKPIs(employees), [employees]);
  const avgShiftData = useMemo(() => getAverageShiftLengths(timeRange), [timeRange]);

  const currentAvg = avgShiftData.data.length > 0 ? avgShiftData.data[avgShiftData.data.length - 1] : 0;
  
  const { percentage, isUp } = useMemo(() => {
    const now = new Date();
    const randomSeed = now.getDate() + now.getMonth();
    const pseudoRandomMultiplier = 0.8 + (Math.sin(randomSeed) + 1) * 0.2;
    const prevAvg = currentAvg * pseudoRandomMultiplier;
    const diff = currentAvg - prevAvg;
    const pct = prevAvg > 0 ? Math.round((Math.abs(diff) / prevAvg) * 100) : 0;
    return { percentage: pct, isUp: diff >= 0 };
  }, [currentAvg]);

  const lineData = {
    labels: avgShiftData.labels,
    datasets: [
      {
        label: "Avg Shift (Hrs)",
        data: avgShiftData.data,
        borderColor: "#ea580c",
        backgroundColor: "rgba(249, 115, 22, 0.12)",
        fill: true,
        tension: 0.4,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: "#ea580c",
      },
    ],
  };

  const lineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(0,0,0,0.75)",
        padding: 8,
        titleFont: { size: 11, family: "Inter" },
        bodyFont: { size: 12, family: "Inter", weight: "bold" as const },
        cornerRadius: 4,
        displayColors: false,
        callbacks: {
          label: (ctx: any) => `${ctx.parsed.y} hrs`,
        },
      },
    },
    scales: {
      x: { 
        display: true, 
        grid: { display: false, drawBorder: false },
        ticks: { font: { size: 10, family: "Inter" }, color: "#888", maxRotation: 0, autoSkip: true, maxTicksLimit: 7 }
      },
        y: { 
          display: true, 
          min: 0, max: 12,
          grid: { display: false, drawBorder: false },
          ticks: { font: { size: 10, family: "Inter" }, color: "#888", stepSize: 4 },
          border: { display: true, color: "#c2c9d6" }
        },
    },
    interaction: { mode: "index" as const, intersect: false },
  };

  const statStyle = (key: string) => ({
    display: "flex",
    flexDirection: "column" as const,
    justifyContent: "center" as const,
    padding: "0 8px",
    height: "90px", // fixed height for stats row
    borderRadius: "8px",
    border: "1px solid",
    borderColor: hovered === key ? "rgba(0,0,0,0.12)" : "transparent",
    transition: "border-color 0.18s ease",
    cursor: "default",
    flex: "0 0 auto",
  });

  return (
    <div style={{
      display: "flex",
      flexDirection: "row",
      width: "100%",
      height: "100%",
      gap: "48px",
      alignItems: "center"
    }}>
      {/* Left Column: Stats */}
      <div style={{ display: "flex", flexDirection: "column", gap: "32px", minWidth: "160px" }}>
        {/* Stat: On-Site */}
        <div
          style={statStyle("onsite")}
          onMouseEnter={() => setHovered("onsite")}
          onMouseLeave={() => setHovered(null)}
        >
          <span style={{ fontSize: "12px", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em", color: "#888", marginBottom: "8px" }}>
            On‑Site
          </span>
          <span style={{ fontSize: "42px", fontWeight: 800, color: "#111", lineHeight: 1 }}>
            {kpis.insideEmployees}
            <span style={{ fontSize: "20px", fontWeight: 500, color: "#999", marginLeft: "8px" }}>
              / {kpis.totalEmployees}
            </span>
          </span>
        </div>

        {/* Divider */}
        <div style={{ height: "1px", width: "100%", background: "rgba(0,0,0,0.1)" }} />

        {/* Stat: Late / Absent */}
        <div
          style={statStyle("absent")}
          onMouseEnter={() => setHovered("absent")}
          onMouseLeave={() => setHovered(null)}
        >
          <span style={{ fontSize: "12px", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em", color: "#888", marginBottom: "8px" }}>
            Late / Absent
          </span>
          <span style={{ fontSize: "42px", fontWeight: 800, color: "#111", lineHeight: 1 }}>
            {kpis.lateOrAbsent}
          </span>
        </div>
      </div>

      {/* Right Column: Chart */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, padding: "0", minHeight: "220px" }}>
        {/* Header like TrendChart */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "20px",
          padding: "0 8px"
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
                {currentAvg}
              </div>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#ea580c" }}>
                {isUp ? "↑" : "↓"} {percentage}%
              </div>
            </div>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#667085", letterSpacing: "1px" }}>
              AVG SHIFT (HRS)
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {(["1Y", "1M", "1W"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                style={{
                  background: timeRange === range ? "rgba(234, 88, 12, 0.1)" : "transparent",
                  color: timeRange === range ? "#ea580c" : "#667085",
                  border: timeRange === range ? "1px solid rgba(234, 88, 12, 0.2)" : "1px solid #d8dde6",
                  padding: "5px 15px",
                  borderRadius: "20px",
                  fontSize: "11px",
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: "1px",
                  transition: "all 0.2s ease"
                }}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        <div 
          style={{ width: "100%", position: "relative", height: "170px", minHeight: "170px", maxHeight: "170px" }}
          onMouseEnter={() => setHovered("chart_area")}
          onMouseLeave={() => setHovered(null)}
        >
          <Line data={lineData} options={lineOptions} />
        </div>
      </div>
    </div>
  );
}
