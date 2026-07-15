"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Person } from "../../lib/types";
import { getPersonSessions } from "../../lib/analyticsUtils";
import { WorkPatternChart } from "./WorkPatternChart";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  Legend,
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
  Legend
);

export function EmployeeProfileCard({
  person,
  onClose,
}: {
  person: Person;
  onClose: () => void;
}) {
  const [timeRange, setTimeRange] = useState("1W");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Generate deterministic chart data based on person.id and timeRange
  const seedVal = person.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  let labels: string[] = [];
  let dataPoints: number[] = [];
  const now = new Date();
  const sessions = getPersonSessions(person.id);
  
  if (timeRange === "1W") {
    const wData = sessions.slice(0, 7).reverse();
    labels = wData.map(d => d.dateStr);
    dataPoints = wData.map(d => d.workedHours);
  } else if (timeRange === "1M") {
    const mData = sessions.slice(0, 30).reverse();
    // Group into 3-day units
    for (let i = 0; i < mData.length; i += 3) {
      const chunk = mData.slice(i, i + 3);
      if (chunk.length > 0) {
        labels.push(chunk[0].dateStr); // Use first day of chunk as label
        const sum = chunk.reduce((acc, curr) => acc + curr.workedHours, 0);
        dataPoints.push(sum);
      }
    }
  } else if (timeRange === "1Y") {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyData: Record<string, number> = {};
    for (const s of sessions.slice(0, 365)) {
      const m = monthNames[s.dateObj.getMonth()];
      monthlyData[m] = (monthlyData[m] || 0) + s.workedHours;
    }
    const today = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const m = monthNames[d.getMonth()];
      labels.push(m);
      dataPoints.push(monthlyData[m] || 0);
    }
  }

  const totalHours = dataPoints.reduce((sum, val) => sum + val, 0);

  const chartData = {
    labels,
    datasets: [
      {
        label: "Hours Worked",
        data: dataPoints,
        borderColor: "#ea580c",
        backgroundColor: "rgba(234, 88, 12, 0.15)",
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 3,
      },
    ],
  };

  const chartFont = {
    family: "var(--admin-font, 'Urbanist', sans-serif)",
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 50, // Give space for the absolute header so the line doesn't hit the text
        left: 0,
        right: 0,
        bottom: 8,
      }
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        displayColors: false,
        titleFont: { ...chartFont, size: 13, weight: 700 as const },
        bodyFont: { ...chartFont, size: 12 },
      },
    },
    scales: {
      y: {
        display: true,
        beginAtZero: true,
        border: { display: false },
        grid: { color: "rgba(0,0,0,0.05)" },
        ticks: {
          font: chartFont,
          color: "#667085",
        }
      },
      x: {
        grid: {
          display: false,
        },
        border: {
          display: false,
        },
      },
    },
  };

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.4)",
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg)",
          width: "100%",
          maxWidth: "850px",
          borderRadius: "12px",
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "var(--admin-font, 'Urbanist', sans-serif)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 24px",
            borderBottom: "1px solid black",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Employee Profile</h2>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              {["1Y", "1M", "1W"].map((range) => {
                const isSelected = range === timeRange;
                const textColor = isSelected ? "#000" : "#667085";
                return (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    style={{
                      background: "transparent",
                      color: textColor,
                      border: `1px solid ${textColor}`,
                      padding: "6px 16px",
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
                );
              })}
            </div>
            <button
              className="icon-button"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "4px",
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div>
              <div style={{ fontSize: "13px", color: "var(--muted)", textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Name</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: "var(--text)" }}>{person.name}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: "var(--muted)", textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Barcode</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: "var(--text)" }}>{person.barcode}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: "var(--muted)", textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Department</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: "var(--text)" }}>{person.department || "-"}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: "var(--muted)", textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Access Level</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: "var(--text)" }}>{person.accessLevel}</div>
            </div>
          </div>

          <div style={{ position: "relative", width: "100%", height: "260px" }}>
            <div style={{ 
              position: "absolute", 
              top: "16px", 
              left: "24px", 
              right: "24px", 
              zIndex: 10, 
              display: "flex", 
              justifyContent: "space-between", 
              alignItems: "flex-start" 
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
                    {totalHours}
                  </div>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#ea580c" }}>
                    ↑ 12% YOY
                  </div>
                </div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#667085", letterSpacing: "1px" }}>
                  TOTAL HOURS
                </div>
              </div>
            </div>
            
            <div style={{ height: "100%", width: "100%", position: "absolute", top: 0, left: 0 }}>
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>

          <div>
            <WorkPatternChart personId={person.id} timeRange={timeRange} />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
