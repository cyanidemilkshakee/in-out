import type { MovementEvent } from "./types";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FACILITY_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export type DashboardTimeRange =
  | "Today"
  | "This Week"
  | "This Month"
  | "This Year"
  | "All Time"
  | "Custom";

function facilityDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
  };
}

function startOfFacilityDay(date = new Date()) {
  const parts = facilityDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - FACILITY_OFFSET_MS;
}

export function parseDateInput(value: string, endOfDay = false) {
  if (!value) return undefined;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const facilityUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(facilityUtc);
  if (
    !Number.isFinite(facilityUtc) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  const start = facilityUtc - FACILITY_OFFSET_MS;
  return endOfDay && !match[4] ? start + DAY_IN_MS - 1 : start;
}

export function dashboardRangeBounds(
  range: DashboardTimeRange,
  startDate = "",
  endDate = "",
  now = new Date()
) {
  const end = startOfFacilityDay(now) + DAY_IN_MS - 1;
  if (range === "Custom") {
    return {
      start: parseDateInput(startDate) ?? Number.NEGATIVE_INFINITY,
      end: parseDateInput(endDate, true) ?? Number.POSITIVE_INFINITY,
    };
  }
  if (range === "All Time") {
    return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
  }
  const days =
    range === "Today"
      ? 1
      : range === "This Week"
        ? 7
        : range === "This Month"
          ? 30
          : 365;
  return { start: end - days * DAY_IN_MS + 1, end };
}

export function compactRangeBounds(
  range: "1D" | "1W" | "1M" | "1Y",
  now = new Date()
) {
  const end = now.getTime();
  const duration =
    range === "1D"
      ? DAY_IN_MS
      : range === "1W"
        ? 7 * DAY_IN_MS
        : range === "1M"
          ? 30 * DAY_IN_MS
          : 365 * DAY_IN_MS;
  return { start: end - duration, end, duration };
}

export function eventTimestamp(event: MovementEvent) {
  const createdAt = event.createdAt ? new Date(event.createdAt).getTime() : NaN;
  const timestamp = Number.isFinite(createdAt)
    ? createdAt
    : new Date(`${event.date} ${event.time}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
