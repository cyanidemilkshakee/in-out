import { useState, useRef, useEffect } from "react";
import { Calendar as CalendarIcon, X } from "lucide-react";

export interface CalendarDatePickerProps {
  startDate: string;
  endDate: string;
  onRangeChange: (start: string, end: string) => void;
  className?: string;
  variant?: "icon" | "segment";
}

const MIN_DATE_TIME = "2016-01-01T00:00";

function getFacilityNowValue() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function clampDateTime(value: string, maximum: string) {
  if (!value) return value;
  if (value < MIN_DATE_TIME) return MIN_DATE_TIME;
  if (value > maximum) return maximum;
  return value;
}

export function CalendarDatePicker({
  startDate,
  endDate,
  onRangeChange,
  className = "",
  variant = "icon",
}: CalendarDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const maximumDateTime = getFacilityNowValue();

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextStart = clampDateTime(e.target.value, maximumDateTime);
    onRangeChange(nextStart, endDate && nextStart > endDate ? nextStart : endDate);
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextEnd = clampDateTime(e.target.value, maximumDateTime);
    onRangeChange(startDate, startDate && nextEnd < startDate ? startDate : nextEnd);
  };

  const rangeInvalid = Boolean(startDate && endDate && startDate > endDate);

  return (
    <div className={`calendar-picker-container ${className}`} ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button 
        type="button" 
        className={`${variant === "segment" ? "dashboard-time-range-button dashboard-calendar-segment" : "icon-filter-button"} ${isOpen ? "active is-active" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Custom Date Range"
        aria-label="Custom date range"
        aria-expanded={isOpen}
        style={{
          background: "transparent",
          border: isOpen ? "1.5px solid var(--admin-text)" : "1px solid transparent",
          borderRadius: "12px",
          padding: "10px",
          color: "var(--admin-text)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "border-color 0.2s"
        }}
      >
        <CalendarIcon size={18} strokeWidth={isOpen ? 1.6 : 1.2} />
        {variant === "segment" ? <span>Custom</span> : null}
      </button>

      {isOpen && (
        <div 
          className="calendar-popover"
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            marginTop: "12px",
            zIndex: 9999,
            backgroundColor: "var(--admin-bg, #f7faf9)",
            border: "1px solid var(--admin-border)",
            borderRadius: "16px",
            padding: "20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.2)",
            width: "320px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            opacity: 1
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h4 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--admin-text)" }}>Select Range</h4>
            <button 
              type="button" 
              onClick={() => setIsOpen(false)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--admin-muted)" }}
            >
              <X size={16} />
            </button>
          </div>
          
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", fontWeight: 600, color: "var(--admin-muted)" }}>
              Start Date & Time
              <input 
                type="datetime-local" 
                value={startDate} 
                onChange={handleStartChange}
                min={MIN_DATE_TIME}
                max={endDate || maximumDateTime}
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--admin-border)",
                  backgroundColor: "var(--admin-bg, #f7faf9)",
                  color: "var(--admin-text)",
                  fontFamily: "inherit",
                  fontSize: "14px",
                  opacity: 1
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", fontWeight: 600, color: "var(--admin-muted)" }}>
              End Date & Time
              <input 
                type="datetime-local" 
                value={endDate} 
                onChange={handleEndChange}
                min={startDate || MIN_DATE_TIME}
                max={maximumDateTime}
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--admin-border)",
                  backgroundColor: "var(--admin-bg, #f7faf9)",
                  color: "var(--admin-text)",
                  fontFamily: "inherit",
                  fontSize: "14px",
                  opacity: 1
                }}
              />
            </label>
          </div>
          <small className={rangeInvalid ? "calendar-range-error" : "calendar-timezone-note"}>
            {rangeInvalid
              ? "Start date must not be after end date."
              : "Facility time: UTC+05:30. Dates before Jan 1, 2016 and future times are unavailable."}
          </small>
        </div>
      )}
    </div>
  );
}
