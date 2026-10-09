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
import type { MovementEvent } from "../../../lib/types";
import { compactRangeBounds, eventTimestamp } from "../../../lib/dateRanges";
import { useAdminTheme } from "../../hooks/useAdminTheme";

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

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif",
};

export function TrendChart({ events = [], timeRange = "1D", onTimeRangeChange }: { events?: MovementEvent[], timeRange?: TimeRange, onTimeRangeChange?: (range: TimeRange) => void }) {
  const darkTheme = useAdminTheme() === "dark";

  const { avgMovements, percentage, isUp, labelUnit, chartData } = useMemo(() => {
    const now = new Date();
    const { start, end, duration } = compactRangeBounds(timeRange, now);
    const bucketCount = timeRange === "1W" ? 7 : timeRange === "1M" ? 10 : 12;
    const bucketDuration = duration / bucketCount;
    const labels = Array.from({ length: bucketCount }, (_, index) => {
      const date = new Date(start + index * bucketDuration);
      if (timeRange === "1D") {
        return date.toLocaleTimeString("en-US", {
          hour: "numeric",
          timeZone: "Asia/Kolkata",
        });
      }
      if (timeRange === "1W") {
        return date.toLocaleDateString("en-US", {
          weekday: "short",
          timeZone: "Asia/Kolkata",
        });
      }
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: timeRange === "1M" ? "numeric" : undefined,
        timeZone: "Asia/Kolkata",
      });
    });
    const entryData = Array.from({ length: bucketCount }, () => 0);
    let currentCount = 0;
    let previousCount = 0;
    for (const event of events) {
      const timestamp = eventTimestamp(event);
      if (timestamp >= start && timestamp <= end) {
        currentCount += 1;
        const index = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((timestamp - start) / bucketDuration))
        );
        entryData[index] += 1;
      } else if (timestamp >= start - duration && timestamp < start) {
        previousCount += 1;
      }
    }
    const divisor =
      timeRange === "1D" ? 24 : timeRange === "1W" ? 7 : timeRange === "1M" ? 30 : 12;
    const avgMovements = Math.round(currentCount / divisor);
    const previousAverage = Math.round(previousCount / divisor);
    const difference = avgMovements - previousAverage;
    const percentage =
      previousAverage > 0
        ? Math.round((Math.abs(difference) / previousAverage) * 100)
        : currentCount > 0
          ? 100
          : 0;
    const isUp = difference >= 0;
    const labelUnit =
      timeRange === "1D"
        ? "AVG MOVEMENTS / HOUR"
        : timeRange === "1Y"
          ? "AVG MOVEMENTS / MONTH"
          : "AVG MOVEMENTS / DAY";

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
          label: "Movements",
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
          titleFont: { ...chartFont, size: 15, weight: 700 as const },
          bodyFont: { ...chartFont, size: 15 },
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
            font: { ...chartFont, size: 15, weight: 600 as const },
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
            font: { ...chartFont, size: 15, weight: 600 as const },
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
  }, [darkTheme]);

  return (
    <div className="trend-chart-container">
      {/* Header Section */}
      <div className="trend-chart-header">
        <div className="trend-chart-summary-list">
          <div className="trend-chart-summary">
            <div className="trend-chart-value-row">
              <div className="trend-chart-value">
                {avgMovements.toLocaleString()}
              </div>
              <div className="trend-chart-change">
                {isUp ? "↑" : "↓"} {percentage}%
              </div>
            </div>
            <div className="trend-chart-unit">
              {labelUnit}
            </div>
          </div>
        </div>

        <div className="trend-chart-range-controls">
          {(["1Y", "1M", "1W", "1D"] as TimeRange[]).map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => onTimeRangeChange?.(range)}
              className={`chart-range-button${timeRange === range ? " is-active" : ""}`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Graph Section */}
      <div className="trend-chart-graph">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
