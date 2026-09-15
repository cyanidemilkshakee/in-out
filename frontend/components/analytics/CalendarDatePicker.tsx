import { useEffect, useRef, useState } from "react";
import { Calendar as CalendarIcon, Check, X } from "lucide-react";

export interface CalendarDatePickerProps {
  startDate: string;
  endDate: string;
  onRangeChange: (start: string, end: string) => void;
  className?: string;
  variant?: "icon" | "segment";
  active?: boolean;
}

const MIN_DATE = "2016-01-01";

function getFacilityToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function displayRange(start: string, end: string) {
  if (!start && !end) return "Custom dates";
  if (start && end) return `${start} → ${end}`;
  return start ? `From ${start}` : `Until ${end}`;
}

export function CalendarDatePicker({
  startDate,
  endDate,
  onRangeChange,
  className = "",
  variant = "icon",
  active = false,
}: CalendarDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const maximumDate = getFacilityToday();
  const isSegment = variant === "segment";

  useEffect(() => {
    if (!isOpen) {
      setDraftStart(startDate);
      setDraftEnd(endDate);
      setError("");
    }
  }, [endDate, isOpen, startDate]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function openPicker() {
    setDraftStart(startDate);
    setDraftEnd(endDate);
    setError("");
    setIsOpen(true);
  }

  function applyRange() {
    const nextStart = validDate(draftStart);
    const nextEnd = validDate(draftEnd);
    if (nextStart && nextEnd && nextStart > nextEnd) {
      setError("Start date must not be after end date.");
      return;
    }
    onRangeChange(nextStart, nextEnd);
    setIsOpen(false);
  }

  function clearRange() {
    onRangeChange("", "");
    setDraftStart("");
    setDraftEnd("");
    setError("");
    setIsOpen(false);
  }

  return (
    <div className={`calendar-picker-container ${className}`} ref={containerRef}>
      <button
        type="button"
        className={`${isSegment ? "dashboard-time-range-button dashboard-calendar-segment" : "icon-filter-button"}${isOpen ? " active" : ""}${isSegment && active ? " is-active" : ""}`}
        onClick={() => (isOpen ? setIsOpen(false) : openPicker())}
        title="Choose custom date range"
        aria-label="Choose custom date range"
        aria-expanded={isOpen}
        aria-pressed={isSegment ? active : undefined}
      >
        {!isSegment ? <CalendarIcon size={18} strokeWidth={1.6} /> : null}
        {isSegment ? <span>Custom</span> : null}
      </button>

      {isOpen ? (
        <div className="calendar-popover" role="dialog" aria-label="Custom date range">
          <div className="calendar-popover-heading">
            <div>
              <strong>Custom date range</strong>
              <small>{displayRange(draftStart, draftEnd)}</small>
            </div>
            <button type="button" aria-label="Close date picker" onClick={() => setIsOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="calendar-date-fields">
            <label>
              <span>Start date</span>
              <input
                type="date"
                value={draftStart}
                min={MIN_DATE}
                max={draftEnd || maximumDate}
                onChange={(event) => setDraftStart(event.target.value)}
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                value={draftEnd}
                min={draftStart || MIN_DATE}
                max={maximumDate}
                onChange={(event) => setDraftEnd(event.target.value)}
              />
            </label>
          </div>

          <small className={error ? "calendar-range-error" : "calendar-timezone-note"}>
            {error || "Facility time · UTC+05:30 · Future dates are unavailable."}
          </small>

          <div className="calendar-popover-actions">
            <button type="button" className="calendar-clear-button" onClick={clearRange}>
              Clear
            </button>
            <button type="button" className="calendar-apply-button" onClick={applyRange}>
              <Check size={15} />
              Apply range
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
