const MINUTE_MS = 60_000;
const FACILITY_OFFSET_MS = 330 * MINUTE_MS;
export const ACCESS_START_GRACE_MS = 5 * MINUTE_MS;
export const ACCESS_WINDOW_MONTHS = 6;

export type DateRangeErrors = { start?: string; end?: string };

function parseParts(value: string, withTime: boolean) {
  const match = value.match(withTime ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const [year, month, day, hour = 0, minute = 0] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const wallTime = new Date(0);
  wallTime.setUTCFullYear(year, month - 1, day);
  wallTime.setUTCHours(hour, minute, 0, 0);
  if (wallTime.getUTCFullYear() !== year || wallTime.getUTCMonth() !== month - 1 || wallTime.getUTCDate() !== day || wallTime.getUTCHours() !== hour || wallTime.getUTCMinutes() !== minute) return undefined;
  return wallTime.getTime() - FACILITY_OFFSET_MS;
}

/** Parse real calendar values in facility time, rejecting date/time rollover. */
export function parseFacilityDateTime(value: string): number | undefined {
  return parseParts(value, true);
}

export function parseFacilityDate(value: string): number | undefined {
  return parseParts(value, false);
}

function facilityInput(timestamp: number) {
  return new Date(timestamp + FACILITY_OFFSET_MS).toISOString().slice(0, 16);
}

export function facilityToday(now = new Date()) {
  return facilityInput(now.getTime()).slice(0, 10);
}

/** Calendar months in facility time; clamp dates such as August 31 to February's last day. */
export function addFacilityCalendarMonths(now: Date, months: number): Date {
  const wallTime = new Date(now.getTime() + FACILITY_OFFSET_MS);
  const target = new Date(wallTime);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(target);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(wallTime.getUTCDate(), lastDay.getUTCDate()));
  return new Date(target.getTime() - FACILITY_OFFSET_MS);
}

export function accessWindowBounds(now = new Date()) {
  return {
    min: facilityInput(Math.floor((now.getTime() - ACCESS_START_GRACE_MS) / MINUTE_MS) * MINUTE_MS),
    max: facilityInput(Math.floor(addFacilityCalendarMonths(now, ACCESS_WINDOW_MONTHS).getTime() / MINUTE_MS) * MINUTE_MS),
    defaultStart: facilityInput(Math.ceil(now.getTime() / MINUTE_MS) * MINUTE_MS),
  };
}

/** Native minute-picker limits; submission validation also checks the exact current instant. */
export function accessDateTimeLimits(start: string, end: string, now = new Date()) {
  const bounds = accessWindowBounds(now);
  const first = parseFacilityDateTime(start);
  const last = parseFacilityDateTime(end);
  const earliest = parseFacilityDateTime(bounds.min)!;
  const latest = parseFacilityDateTime(bounds.max)!;
  const futureMinute = (Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS;
  const startMax = last !== undefined && last > earliest && last <= latest ? last - MINUTE_MS : latest - MINUTE_MS;
  const endMin = first !== undefined && first < latest ? Math.max(futureMinute, first + MINUTE_MS) : futureMinute;
  return { start: { min: bounds.min, max: facilityInput(startMax) }, end: { min: facilityInput(endMin), max: bounds.max } };
}

export function validateAccessWindow(start: string, end: string, now = new Date(), permanent = false): DateRangeErrors {
  const errors: DateRangeErrors = {};
  const first = parseFacilityDateTime(start);
  const latest = addFacilityCalendarMonths(now, ACCESS_WINDOW_MONTHS).getTime();
  if (first === undefined) errors.start = "Enter a valid start date and time.";
  else if (first < now.getTime() - ACCESS_START_GRACE_MS) errors.start = "Start time must be now or later (up to 5 minutes of clock grace).";
  else if (first > latest) errors.start = "Start time must be within the next 6 calendar months.";
  if (permanent) return errors;
  const last = parseFacilityDateTime(end);
  if (last === undefined) errors.end = "Enter a valid end date and time.";
  else if (last <= now.getTime()) errors.end = "End time must be in the future.";
  else if (last > latest) errors.end = "End time must be within the next 6 calendar months.";
  else if (first !== undefined && last <= first) errors.end = "End time must be after start time.";
  return errors;
}

export function validateHistoricalDateRange(start: string, end: string, now = new Date()): DateRangeErrors {
  const errors: DateRangeErrors = {};
  const today = facilityToday(now);
  if (start && parseFacilityDate(start) === undefined) errors.start = "Enter a valid start date.";
  else if (start > today) errors.start = "Start date cannot be in the future.";
  if (end && parseFacilityDate(end) === undefined) errors.end = "Enter a valid end date.";
  else if (end > today) errors.end = "End date cannot be in the future.";
  else if (!errors.start && start && end && start > end) errors.end = "Start date must not be after end date.";
  return errors;
}

export function historicalDateTimeLimits(start: string, end: string, now = new Date()) {
  const maximum = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const first = parseFacilityDateTime(start);
  const last = parseFacilityDateTime(end);
  return {
    start: { max: facilityInput(last !== undefined ? Math.min(maximum, last - MINUTE_MS) : maximum) },
    end: { min: first !== undefined ? facilityInput(first + MINUTE_MS) : undefined, max: facilityInput(maximum) },
  };
}

export function validateHistoricalDateTimeRange(start: string, end: string, now = new Date()): DateRangeErrors {
  const errors: DateRangeErrors = {};
  const first = parseFacilityDateTime(start);
  const last = parseFacilityDateTime(end);
  if (first === undefined) errors.start = "Enter a valid entry date and time.";
  else if (first > now.getTime()) errors.start = "Entry time cannot be in the future.";
  if (last === undefined) errors.end = "Enter a valid exit date and time.";
  else if (last > now.getTime()) errors.end = "Exit time cannot be in the future.";
  else if (first !== undefined && last <= first) errors.end = "Exit time must be after entry time.";
  return errors;
}
