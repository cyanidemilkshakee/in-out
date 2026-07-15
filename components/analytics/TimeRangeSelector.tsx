"use client";

type TimeRangeSelectorProps = {
  timeRange: string;
  timeRanges: readonly string[];
  onSelect: (range: string) => void;
};

export function TimeRangeSelector({ timeRange, timeRanges, onSelect }: TimeRangeSelectorProps) {
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
    </div>
  );
}
