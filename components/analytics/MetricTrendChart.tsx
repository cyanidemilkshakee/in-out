"use client";

import { useMemo } from "react";
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
import type { TimeRange } from "./TrendChart";

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

type MetricTrendChartProps = {
  title: string;
  valueLabel: string;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  color?: string;
  seed?: number;
  unit?: string;
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function valueFor(seed: number, index: number, range: TimeRange) {
  const wave = Math.sin((index + seed) * 0.72);
  const seasonal = Math.cos((index + seed) * 0.19);
  const base = range === "1Y" ? 42 : range === "1M" ? 34 : range === "1W" ? 28 : 18;
  return Math.max(0, Math.round(base + wave * 8 + seasonal * 5 + (seed % 7)));
}

export function MetricTrendChart({
  title,
  valueLabel,
  timeRange,
  onTimeRangeChange,
  color = "#0b63e5",
  seed = 11,
  unit = ""
}: MetricTrendChartProps) {
  const chartFont = {
    family: "var(--font-urbanist, Urbanist), Arial, sans-serif",
  };

  const { labels, values, average, labelUnit, percentage, isUp } = useMemo(() => {
    const now = new Date();
    const nextLabels: string[] = [];
    const nextValues: number[] = [];

    if (timeRange === "1Y") {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now);
        d.setMonth(now.getMonth() - i);
        nextLabels.push(monthNames[d.getMonth()]);
        nextValues.push(valueFor(seed, 11 - i, timeRange));
      }
    } else if (timeRange === "1M") {
      for (let i = 29; i >= 0; i -= 3) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        nextLabels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
        nextValues.push(valueFor(seed, 29 - i, timeRange));
      }
    } else if (timeRange === "1W") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        nextLabels.push(d.toLocaleDateString("en-US", { weekday: "short" }));
        nextValues.push(valueFor(seed, 6 - i, timeRange));
      }
    } else {
      for (let i = 22; i >= 0; i -= 2) {
        const d = new Date(now);
        d.setHours(now.getHours() - i);
        nextLabels.push(d.toLocaleTimeString("en-US", { hour: "numeric" }));
        nextValues.push(valueFor(seed, 22 - i, timeRange));
      }
    }

    const sum = nextValues.reduce((s, value) => s + value, 0);
    const average = Math.round(sum / (nextValues.length || 1));

    let labelUnit = valueLabel;
    const randomSeed = now.getDate() + seed;
    const pseudoRandomMultiplier = 0.8 + (Math.sin(randomSeed) + 1) * 0.2;
    const prevAverage = Math.round(average * pseudoRandomMultiplier);
    const diff = average - prevAverage;
    const percentage = prevAverage > 0 ? Math.round((Math.abs(diff) / prevAverage) * 100) : 0;
    const isUp = diff >= 0;

    return {
      labels: nextLabels,
      values: nextValues,
      average,
      labelUnit,
      percentage,
      isUp
    };
  }, [seed, timeRange]);

  const chartData = useMemo(() => {
    return {
      labels,
      datasets: [
        {
          label: valueLabel,
          data: values,
          borderColor: color,
          borderWidth: 3,
          tension: 0.4,
          pointBackgroundColor: "#ffffff",
          pointBorderColor: color,
          pointBorderWidth: 0,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: true,
          backgroundColor: color + "1a", // 10% opacity roughly
        },
      ],
    };
  }, [labels, values, color, valueLabel]);

  const options = useMemo(() => {
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
          backgroundColor: "#ffffff",
          titleColor: "#111827",
          bodyColor: "#4b5563",
          borderColor: "#d8dde6",
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
            color: "#667085",
            font: { ...chartFont, size: 10, weight: 600 as const },
            padding: 8,
          },
          border: {
            display: false
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
            color: "#667085",
            font: { ...chartFont, size: 10, weight: 600 as const },
            maxTicksLimit: 4,
          },
          border: {
            display: false
          }
        },
      },
      interaction: {
        intersect: false,
        mode: "index" as const,
      },
    };
  }, [chartFont]);

  const getButtonStyle = (range: TimeRange) => ({
    background: timeRange === range ? color + "1a" : "transparent",
    color: timeRange === range ? color : "#667085",
    border: timeRange === range ? `1px solid ${color}33` : "1px solid #d8dde6",
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
              <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
                {average.toLocaleString()}
                {unit}
              </div>
              <div style={{ fontSize: "12px", fontWeight: 700, color: color }}>
                {isUp ? "↑" : "↓"} {percentage}%
              </div>
            </div>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#667085", letterSpacing: "1px", textTransform: "uppercase" }}>
              {labelUnit}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          {(["1Y", "1M", "1W", "1D"] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => onTimeRangeChange(range)}
              style={getButtonStyle(range)}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Graph Section */}
      <div style={{ height: "170px", width: "100%", position: "relative", padding: "0" }}>
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
