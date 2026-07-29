"use client";

import { useMemo, type CSSProperties } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { compactRangeBounds } from "../../../lib/dateRanges";
import type { TimeRange } from "./TrendChart";

export type MetricTrendPoint = {
  timestamp: string;
  value: number;
};

type MetricTrendChartProps = {
  title: string;
  valueLabel: string;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  points: MetricTrendPoint[];
  aggregation?: "sum" | "average";
  color?: string;
  unit?: string;
};

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif",
};

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export function MetricTrendChart({
  title,
  valueLabel,
  timeRange,
  onTimeRangeChange,
  points,
  aggregation = "sum",
  color = "#0b63e5",
  unit = "",
}: MetricTrendChartProps) {
  const { labels, values, average, percentage, isUp } = useMemo(() => {
    const now = new Date();
    const { start, end, duration } = compactRangeBounds(timeRange, now);
    const bucketCount = timeRange === "1W" ? 7 : timeRange === "1M" ? 10 : 12;
    const bucketDuration = duration / bucketCount;
    const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
    const previousValues: number[] = [];

    for (const point of points) {
      const timestamp = new Date(point.timestamp).getTime();
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp >= start && timestamp <= end) {
        const index = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((timestamp - start) / bucketDuration))
        );
        buckets[index].push(point.value);
      } else if (timestamp >= start - duration && timestamp < start) {
        previousValues.push(point.value);
      }
    }

    const aggregate = (bucket: number[]) => {
      const total = bucket.reduce((sum, value) => sum + value, 0);
      return aggregation === "average" && bucket.length
        ? total / bucket.length
        : total;
    };
    const values = buckets.map((bucket) => Number(aggregate(bucket).toFixed(1)));
    const currentPointValues = buckets.flat();
    const average = Number(
      (currentPointValues.length ? aggregate(currentPointValues) : 0).toFixed(1)
    );
    const previousAverage = Number(
      (previousValues.length ? aggregate(previousValues) : 0).toFixed(1)
    );
    const difference = average - previousAverage;
    const percentage =
      previousAverage > 0
        ? Math.round((Math.abs(difference) / previousAverage) * 100)
        : average > 0
          ? 100
          : 0;
    const labels = buckets.map((_, index) => {
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

    return {
      labels,
      values,
      average,
      percentage,
      isUp: difference >= 0,
    };
  }, [aggregation, points, timeRange]);

  const chartData = useMemo(
    () => ({
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
          backgroundColor: `${color}1a`,
        },
      ],
    }),
    [color, labels, valueLabel, values]
  );

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: "easeOutQuart" as const },
      plugins: {
        legend: { display: false },
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
          grid: { display: false, drawBorder: false },
          ticks: {
            color: "#667085",
            font: { ...chartFont, size: 10, weight: 600 as const },
            padding: 8,
          },
          border: { display: false },
        },
        y: {
          display: true,
          min: 0,
          grid: { display: false, drawBorder: false },
          ticks: {
            color: "#667085",
            font: { ...chartFont, size: 10, weight: 600 as const },
            maxTicksLimit: 4,
          },
          border: { display: false },
        },
      },
      interaction: { intersect: false, mode: "index" as const },
    }),
    []
  );

  return (
    <div className="metric-trend-chart" style={{ fontFamily: chartFont.family }}>
      <div className="metric-trend-header">
        <div>
          <div className="metric-trend-title">{title}</div>
          <div className="metric-trend-value-row">
            <strong>
              {average.toLocaleString()}
              {unit}
            </strong>
            <span style={{ color }}>{isUp ? "↑" : "↓"} {percentage}%</span>
          </div>
          <div className="metric-trend-label">{valueLabel}</div>
        </div>
        <div className="chart-range-controls">
          {(["1Y", "1M", "1W", "1D"] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => onTimeRangeChange(range)}
              className={`chart-range-button${timeRange === range ? " is-active" : ""}`}
              style={{ "--chart-accent": color } as CSSProperties}
              type="button"
            >
              {range}
            </button>
          ))}
        </div>
      </div>
      <div className="metric-trend-canvas">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
