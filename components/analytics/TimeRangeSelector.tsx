"use client";

type TimeRangeSelectorProps = {
  timeRange: string;
  timeRanges: readonly string[];
  onSelect: (range: string) => void;
};

export function TimeRangeSelector({ timeRange, timeRanges, onSelect }: TimeRangeSelectorProps) {
  return (
    <div style={{
      position: "absolute",
      top: "32px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      background: "rgba(24, 32, 31, 0.04)",
      padding: "6px",
      borderRadius: "20px",
      gap: "6px",
      zIndex: 10
    }}>
      {timeRanges.map(range => (
        <button
          key={range}
          onClick={() => onSelect(range)}
          style={{
            background: timeRange === range ? "#fff" : "transparent",
            color: timeRange === range ? "#000" : "#52605d",
            border: "none",
            padding: "8px 16px",
            borderRadius: "16px",
            fontSize: "16px",
            fontWeight: timeRange === range ? 700 : 600,
            cursor: "pointer",
            boxShadow: timeRange === range ? "0 2px 6px rgba(0,0,0,0.1)" : "none",
            transition: "all 0.2s ease"
          }}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
