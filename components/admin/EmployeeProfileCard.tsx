"use client";

import { useEffect, useState, type CSSProperties } from "react";
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
import type { ChartOptions } from "chart.js";
import { useDataState } from "../../context/DataContext";

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
  const { movements } = useDataState();
  const [timeRange, setTimeRange] = useState("1W");
  const [mounted, setMounted] = useState(false);
  const [darkTheme, setDarkTheme] = useState(false);
  useEffect(() => {
    setMounted(true);
    const syncTheme = () => {
      setDarkTheme(document.documentElement.dataset.adminTheme === "dark");
    };

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-admin-theme"] });
    return () => observer.disconnect();
  }, []);

  let labels: string[] = [];
  let dataPoints: number[] = [];
  const now = new Date();
  const sessions = getPersonSessions(person.id, movements);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const sessionsByDay = new Map(sessions.map((session) => [dayKey(session.dateObj), session.workedHours]));
  
  if (timeRange === "1W") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      labels.push(`${d.getDate()} ${monthNames[d.getMonth()]}`);
      dataPoints.push(sessionsByDay.get(dayKey(d)) ?? 0);
    }
  } else if (timeRange === "1M") {
    for (let i = 29; i >= 0; i -= 3) {
      const start = new Date(now);
      start.setDate(now.getDate() - i);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 2);
      end.setHours(23, 59, 59, 999);
      labels.push(`${start.getDate()} ${monthNames[start.getMonth()]}`);

      let threeDayTotal = 0;
      for (const session of sessions) {
        if (session.dateObj >= start && session.dateObj <= end) {
          threeDayTotal += session.workedHours;
        }
      }
      dataPoints.push(Number(threeDayTotal.toFixed(1)));
    }
  } else if (timeRange === "1Y") {
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
  const displayedHours = Number.isInteger(totalHours) ? String(totalHours) : totalHours.toFixed(1);
  const trendUnit = timeRange === "1Y" ? "YOY" : timeRange === "1M" ? "MOM" : "WOW";
  const panelBackground = darkTheme ? "#0f1413" : "rgb(237, 242, 240)";
  const textColor = darkTheme ? "#eef7f2" : "#18201f";
  const mutedColor = darkTheme ? "#aab8b3" : "#667085";
  const borderColor = darkTheme ? "#2e2e2e" : "rgba(24, 32, 31, 0.18)";
  const panelLine = darkTheme ? "rgba(196, 211, 204, 0.24)" : "rgba(176, 190, 186, 0.5)";
  const tooltipBackground = darkTheme ? "#151515" : "#ffffff";
  const tooltipBody = darkTheme ? "#aab8b3" : "#4b5563";

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

  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 74, // Give space for the absolute header so the line doesn't hit the text
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
        backgroundColor: tooltipBackground,
        titleColor: textColor,
        bodyColor: tooltipBody,
        borderColor,
        borderWidth: 1,
        titleFont: { ...chartFont, size: 13, weight: 700 as const },
        bodyFont: { ...chartFont, size: 12 },
      },
    },
    scales: {
      y: {
        display: true,
        beginAtZero: true,
        border: { display: false },
        grid: { display: false },
        ticks: {
          font: chartFont,
          color: mutedColor,
        }
      },
      x: {
        grid: {
          display: false,
        },
        border: {
          display: false,
        },
        ticks: {
          font: chartFont,
          color: mutedColor,
        }
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
          "--admin-bg": panelBackground,
          "--admin-text": textColor,
          "--admin-muted": mutedColor,
          "--admin-line": panelLine,
          background: panelBackground,
          color: textColor,
          width: "100%",
          maxWidth: "850px",
          borderRadius: "12px",
          boxShadow: darkTheme ? "0 24px 80px rgba(0, 0, 0, 0.48)" : "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "var(--admin-font, 'Urbanist', sans-serif)",
        } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 24px",
            borderBottom: `1px solid ${borderColor}`,
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Employee Profile</h2>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              {["1Y", "1M", "1W"].map((range) => {
                const isSelected = range === timeRange;
                const rangeTextColor = isSelected ? textColor : mutedColor;
                return (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setTimeRange(range)}
                    style={{
                      background: "transparent",
                      color: rangeTextColor,
                      border: `1px solid ${isSelected ? textColor : mutedColor}`,
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
              <div style={{ fontSize: "13px", color: mutedColor, textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Name</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: textColor }}>{person.name}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: mutedColor, textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Barcode</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: textColor }}>{person.barcode}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: mutedColor, textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Department</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: textColor }}>{person.department || "-"}</div>
            </div>
            <div>
              <div style={{ fontSize: "13px", color: mutedColor, textTransform: "uppercase", fontWeight: 500, letterSpacing: "0.5px", marginBottom: "4px" }}>Access Level</div>
              <div style={{ fontWeight: 700, fontSize: "18px", color: textColor }}>{person.accessLevel}</div>
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
                  <div style={{ fontSize: "32px", fontWeight: 800, color: textColor, lineHeight: 1 }}>
                    {displayedHours}
                  </div>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#ea580c" }}>
                    ↑ 12% {trendUnit}
                  </div>
                </div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: mutedColor, letterSpacing: "1px" }}>
                  TOTAL HOURS
                </div>
              </div>
            </div>
            
            <div style={{ height: "100%", width: "100%", position: "absolute", top: 0, left: 0 }}>
              <Line data={chartData} options={chartOptions} />
            </div>
          </div>

          <div>
            <WorkPatternChart personId={person.id} timeRange={timeRange} movements={movements} />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
