"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Line } from "react-chartjs-2";
import type { MovementEvent } from "../../lib/types";
import { getDailyMovementCounts } from "../../lib/analyticsUtils";

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

export type TimeRange = "1D" | "1W" | "1M" | "1Y";

export function TrendChart({ events = [], timeRange = "1D", onTimeRangeChange }: { events?: MovementEvent[], timeRange?: TimeRange, onTimeRangeChange?: (range: TimeRange) => void }) {
  const [darkTheme, setDarkTheme] = useState(false);
  const chartFont = {
    family: "var(--font-urbanist, Urbanist), Arial, sans-serif",
  };

  useEffect(() => {
    const syncTheme = () => {
      setDarkTheme(document.documentElement.dataset.adminTheme === "dark");
    };

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-admin-theme"] });
    return () => observer.disconnect();
  }, []);

  const { avgMovements, percentage, isUp, labelUnit, chartData } = useMemo(() => {
    let labels: string[] = [];
    let entryData: number[] = [];
    let calculatedEntriesCount = 0;
    let calculatedExitsCount = 0;

    const now = new Date();

    if (timeRange === "1D") {
      const currentHour = now.getHours();
      for (let i = 22; i >= 0; i -= 2) {
        const d = new Date(now);
        d.setHours(currentHour - i);
        let h = d.getHours();
        
        if (h >= 8 && h <= 20) {
          const val = (h === 8 || h === 9 || h === 16 || h === 17) ? 60 : (h >= 12 && h <= 13 ? 30 : 45);
          entryData.push(val * 2);
          calculatedExitsCount += ((val - 5) * 2);
        } else {
          entryData.push(0);
        }

        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        labels.push(`${h} ${ampm}`);
      }
      calculatedEntriesCount = entryData.reduce((a,b) => a+b, 0);
      
    } else {
      let days = 7;
      if (timeRange === "1M") days = 30;
      if (timeRange === "1Y") days = 365;

      const dailyCounts = getDailyMovementCounts(events, days);
      const sortedDates = Object.keys(dailyCounts).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

      if (timeRange === "1Y") {
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        
        const pseudoRandom = (seed: number) => {
          let x = Math.sin(seed) * 10000;
          return x - Math.floor(x);
        };

        for (let i = 11; i >= 0; i--) {
          const d = new Date(now);
          d.setMonth(d.getMonth() - i);
          labels.push(monthNames[d.getMonth()]);
          
          const seed = d.getMonth() + d.getFullYear() + (i === 0 ? now.getDate() : 0);
          const eCount = Math.floor(400 + pseudoRandom(seed + 10) * 800);
          const xCount = Math.floor(eCount * 0.9 + pseudoRandom(seed + 20) * (eCount * 0.1));
          
          entryData.push(eCount);
          calculatedEntriesCount += eCount;
          calculatedExitsCount += xCount;
        }
      } else {
        const step = timeRange === "1M" ? 3 : 1;
        
        for (let i = 0; i < sortedDates.length; i += step) {
          const chunk = sortedDates.slice(i, i + step);
          labels.push(chunk[0]);
          let eSum = 0;
          let xSum = 0;
          for (const d of chunk) {
            eSum += dailyCounts[d].entries;
            xSum += dailyCounts[d].exits;
            calculatedEntriesCount += dailyCounts[d].entries;
            calculatedExitsCount += dailyCounts[d].exits;
          }
          entryData.push(eSum);
        }
      }
    }

      let divisor = 1;
      let labelUnit = "AVG MOVEMENTS";
      if (timeRange === "1D") { divisor = 24; }
      else if (timeRange === "1W") { divisor = 7; }
      else if (timeRange === "1M") { divisor = 30; }
      else if (timeRange === "1Y") { divisor = 12; }

      const totalMovements = calculatedEntriesCount + calculatedExitsCount;
      const avgMovements = Math.round(totalMovements / divisor);

      // Mock previous period calculation
      const seed = now.getDate() + now.getMonth();
      const pseudoRandomMultiplier = 0.8 + (Math.sin(seed) + 1) * 0.2; // 0.8 to 1.2
      const prevAvgMovements = Math.round(avgMovements * pseudoRandomMultiplier);
      const diff = avgMovements - prevAvgMovements;
      const percentage = prevAvgMovements > 0 ? Math.round((Math.abs(diff) / prevAvgMovements) * 100) : 0;
      const isUp = diff >= 0;

      // Adjust graph points to be averages where necessary
      if (timeRange === "1M") {
        entryData = entryData.map(v => Math.round(v / 3)); // Average per day in 3-day chunks
      } else if (timeRange === "1D") {
        entryData = entryData.map(v => Math.round(v / 2)); // Average per hour in 2-hour chunks
      }

      return {
        avgMovements,
        percentage,
        isUp,
        labelUnit,
        chartData: {
          labels,
          entryData,
        },
      };
  }, [events, timeRange]);

  const data = useMemo(() => {
    return {
      labels: chartData.labels,
      datasets: [
        {
          label: "Entries",
          data: chartData.entryData,
          borderColor: "#0b63e5",
          borderWidth: 3,
          tension: 0.4,
          pointBackgroundColor: "#0b63e5",
          pointBorderColor: "#0b63e5",
          pointBorderWidth: 0,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: true,
          backgroundColor: "rgba(11, 99, 229, 0.14)",
        },
      ],
    };
  }, [chartData]);

  const options = useMemo(() => {
    const tickColor = darkTheme ? "rgba(238, 247, 242, 0.72)" : "#667085";
    const tooltipBackground = darkTheme ? "#151515" : "#ffffff";
    const tooltipTitle = darkTheme ? "#eef7f2" : "#111827";
    const tooltipBody = darkTheme ? "#aab8b3" : "#4b5563";
    const tooltipBorder = darkTheme ? "#2e2e2e" : "#d8dde6";

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: "easeOutQuart" as const,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: tooltipBackground,
          titleColor: tooltipTitle,
          bodyColor: tooltipBody,
          borderColor: tooltipBorder,
          borderWidth: 1,
          titleFont: { ...chartFont, size: 13, weight: 700 as const },
          bodyFont: { ...chartFont, size: 12 },
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
            drawBorder: false,
          },
          ticks: {
            color: tickColor,
            font: { ...chartFont, size: 10, weight: 600 as const },
            padding: 8,
          },
          border: {
            display: false,
            color: "#2e2e2e"
          }
        },
        y: {
          display: true,
          min: 0,
          grid: {
            display: false,
            drawBorder: false,
          },
          ticks: {
            color: tickColor,
            font: { ...chartFont, size: 10, weight: 600 as const },
            maxTicksLimit: 4,
          },
          border: {
            display: false,
            color: "#2e2e2e"
          }
        },
      },
      interaction: {
        intersect: false,
        mode: "index" as const,
      },
    };
  }, [darkTheme, timeRange]);

  const getButtonStyle = (range: TimeRange) => ({
    background: timeRange === range ? "rgba(11, 99, 229, 0.1)" : "transparent",
    color: timeRange === range ? "#0b63e5" : "var(--admin-muted)",
    border: "0",
    padding: "5px 15px",
    borderRadius: "20px",
    fontSize: "11px",
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: "1px",
    transition: "all 0.2s ease"
  });

  return (
    <div
      style={{
        backgroundColor: "transparent",
        width: "100%", 
        margin: "0",
        padding: "0",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
        fontFamily: chartFont.family,
      }}
    >
      {/* Header Section */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          padding: "0 8px",
        }}
      >
        <div style={{ display: "flex", gap: "48px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--admin-text)", lineHeight: 1 }}>
                {avgMovements.toLocaleString()}
              </div>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#0b63e5" }}>
                {isUp ? "↑" : "↓"} {percentage}%
              </div>
            </div>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--admin-muted)", letterSpacing: "1px" }}>
              {labelUnit}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          {(["1Y", "1M", "1W", "1D"] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => onTimeRangeChange?.(range)}
              style={getButtonStyle(range)}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Graph Section */}
      <div style={{ height: "170px", width: "100%", position: "relative", padding: "0" }}>
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
