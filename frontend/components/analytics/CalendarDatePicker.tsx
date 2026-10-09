import { useEffect, useId, useRef, useState } from "react";
import { Calendar as CalendarIcon, Check, X } from "lucide-react";
import { facilityToday, parseFacilityDate, validateHistoricalDateRange } from "../../../lib/dateTimeValidation";
import { useDateTimeNow } from "../../hooks/useDateTimeNow";

export interface CalendarDatePickerProps {
  startDate: string;
  endDate: string;
  onRangeChange: (start: string, end: string) => void;
  className?: string;
  variant?: "icon" | "segment" | "inline";
  active?: boolean;
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
  const errorId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const isInline = variant === "inline";
  const now = useDateTimeNow(isOpen || isInline);
  const maximumDate = facilityToday(now);
  const startMaximum = parseFacilityDate(draftEnd) !== undefined && draftEnd < maximumDate ? draftEnd : maximumDate;
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
    const errors = validateHistoricalDateRange(draftStart, draftEnd);
    if (errors.start || errors.end) {
      setError(errors.start || errors.end || "Choose a valid date range.");
      (errors.start ? startRef : endRef).current?.focus();
      return;
    }
    if (!startRef.current?.reportValidity() || !endRef.current?.reportValidity()) return;
    onRangeChange(draftStart, draftEnd);
    if (!isInline) setIsOpen(false);
  }

  function clearRange() {
    onRangeChange("", "");
    setDraftStart("");
    setDraftEnd("");
    setError("");
    if (!isInline) setIsOpen(false);
  }

  if (isInline) {
    return (
      <div className={`calendar-picker-container calendar-picker-inline ${className}`} ref={containerRef}>
        <div className="calendar-date-fields">
          <label>
            <span>Start date</span>
            <input
              type="date"
              ref={startRef}
              value={draftStart}
              max={startMaximum}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => { setDraftStart(event.target.value); setError(""); }}
            />
          </label>
          <label>
            <span>End date</span>
            <input
              type="date"
              ref={endRef}
              value={draftEnd}
              min={parseFacilityDate(draftStart) !== undefined ? draftStart : undefined}
              max={maximumDate}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => { setDraftEnd(event.target.value); setError(""); }}
            />
          </label>
        </div>
        {error && <small id={errorId} role="alert" className="calendar-range-error">{error}</small>}
        <div className="calendar-popover-actions">
          <button type="button" className="calendar-clear-button" onClick={clearRange}>Clear</button>
          <button type="button" className="calendar-apply-button" onClick={applyRange}>
            <Check size={15} />Apply range
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`calendar-picker-container ${className}`} ref={containerRef}>
      <button
        type="button"
        className={`${isSegment ? "dashboard-time-range-button dashboard-calendar-segment" : "icon-filter-button"}${isOpen ? " active" : ""}${isSegment && active ? " is-active" : ""}`}
        onClick={() => (isOpen ? setIsOpen(false) : openPicker())}
        title="Choose date range"
        aria-label="Choose date range"
        aria-expanded={isOpen}
        aria-pressed={isSegment ? active : undefined}
      >
        {!isSegment ? <CalendarIcon size={18} strokeWidth={1.6} /> : null}
        {isSegment ? <span>Custom</span> : null}
      </button>

      {isOpen ? (
        <div className="calendar-popover" role="dialog" aria-label="Date range">
          <div className="calendar-popover-heading">
            <strong>Date range</strong>
            <button type="button" aria-label="Close date picker" onClick={() => setIsOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="calendar-date-fields">
            <label>
              <span>Start date</span>
              <input
                type="date"
                ref={startRef}
                value={draftStart}
                max={startMaximum}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => { setDraftStart(event.target.value); setError(""); }}
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                ref={endRef}
                value={draftEnd}
                min={parseFacilityDate(draftStart) !== undefined ? draftStart : undefined}
                max={maximumDate}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => { setDraftEnd(event.target.value); setError(""); }}
              />
            </label>
          </div>

          {error && <small id={errorId} role="alert" className="calendar-range-error">{error}</small>}

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
