"use client";

import { CalendarDatePicker } from "./CalendarDatePicker";

type TimeRangeSelectorProps = {
  timeRange: string;
  timeRanges: readonly string[];
  onSelect: (range: string) => void;
  startDate?: string;
  endDate?: string;
  onRangeChange?: (start: string, end: string) => void;
};

export function TimeRangeSelector({
  timeRange,
  timeRanges,
  onSelect,
  startDate = "",
  endDate = "",
  onRangeChange,
}: TimeRangeSelectorProps) {
  return (
    <div className="dashboard-time-range-selector" aria-label="Dashboard time range">
      {timeRanges.map(range => (
        <button
          key={range}
          type="button"
          className={`dashboard-time-range-button${timeRange === range ? " is-active" : ""}`}
          aria-pressed={timeRange === range}
          onClick={() => onSelect(range)}
        >
          {range}
        </button>
      ))}
      {onRangeChange ? (
        <CalendarDatePicker
          startDate={startDate}
          endDate={endDate}
          onRangeChange={onRangeChange}
          variant="segment"
        />
      ) : null}
    </div>
  );
}
