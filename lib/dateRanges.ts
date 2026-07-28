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

export function startOfFacilityDay(date = new Date()) {
  const parts = facilityDateParts(date);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - FACILITY_OFFSET_MS;
}

export function parseDateInput(value: string, endOfDay = false) {
  if (!value) return undefined;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return undefined;
  const start =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
      Number(match[6] ?? 0)
    ) -
    FACILITY_OFFSET_MS;
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
  const timestamp = event.createdAt
    ? new Date(event.createdAt).getTime()
    : new Date(`${event.date} ${event.time}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatRelativeTime(value?: string, now = Date.now()) {
  if (!value) return "Time unavailable";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
