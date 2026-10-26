import type { EmployeeActivity, MovementQuery } from "./types";
import type { DayPattern } from "./analyticsUtils";

export function dashboardMovementLogHref(
  subjectGroup: "people" | "hardware",
  bounds: { startAt: string | null; endAt: string },
  filters: Record<string, string>,
) {
  const query = new URLSearchParams({ subject: subjectGroup, ...filters });
  if (bounds.startAt) query.set("startAt", bounds.startAt);
  query.set("endAt", bounds.endAt);
  return `/admin/logs?${query}`;
}

export function movementAnalyticsFilters(params: URLSearchParams) {
  const category = params.get("denialCategory");
  const validDate = (key: string) => {
    const value = params.get(key);
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  };
  return {
    denialCategory: category === "restricted" || category === "other"
      ? category : undefined,
    startAt: validDate("startAt"), endAt: validDate("endAt"),
  } satisfies Pick<MovementQuery, "denialCategory" | "startAt" | "endAt">;
}

export type PeriodComparison = { direction: "up" | "down" | "flat"; percentage: number | null };
export function comparePeriods(current: number, previous: number): PeriodComparison {
  if (Math.abs(current - previous) < 1e-9) return { direction: "flat", percentage: 0 };
  if (previous === 0) return { direction: current > 0 ? "up" : "flat", percentage: null };
  return { direction: current > previous ? "up" : "down",
    percentage: Math.round(Math.abs(current - previous) / previous * 100) };
}

export type EmployeeActivityRange = "1D" | "1W" | "1M" | "1Y" | "ALL";

export function employeeActivityRangeDays(range: EmployeeActivityRange) {
  return range === "ALL" ? 0 : range === "1D" ? 1 : range === "1W" ? 7 : range === "1M" ? 30 : range === "1Y" ? 365 : 7;
}

export function averageWorkedHoursPerDay(days: ReadonlyArray<Pick<DayPattern, "workedHours">>, periodDays: number) {
  if (!days.length || periodDays <= 0) return null;
  return days.reduce((total, day) => total + day.workedHours, 0) / periodDays;
}

export function employeeActivityPatterns(activity: EmployeeActivity): DayPattern[] {
  return activity.days.map(day => {
    // dateObj is a facility calendar date, represented at UTC midnight everywhere.
    const dateObj = new Date(`${day.date}T00:00:00Z`);
    return { ...day, dateObj,
      dateStr: dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) };
  });
}

export function employeeHoursSeries(activity: EmployeeActivity, range: "1W" | "1M" | "1Y" | "ALL") {
  const byDay = new Map(activity.days.map(day => [day.date, day.workedHours]));
  const facilityDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(activity.endAt));
  const lastDay = new Date(`${facilityDate}T00:00:00Z`);
  const days = range === "ALL" ? activity.days.length : range === "1W" ? 7 : range === "1M" ? 30 : 365;
  const buckets = new Map<string, { label: string; hours: number; dayCount: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(lastDay);
    date.setUTCDate(date.getUTCDate() - i);
    const key = date.toISOString().slice(0, 10);
    // A year is 365 days, including the first partial calendar month.
    const bucket = range === "ALL" || range === "1Y" ? key.slice(0, 7) : range === "1M" ? String(Math.floor((days - 1 - i) / 3)) : key;
    const existing = buckets.get(bucket);
    const hours = byDay.get(key) ?? 0;
    if (existing) {
      existing.hours += hours;
      existing.dayCount += 1;
    } else buckets.set(bucket, { label: date.toLocaleDateString("en-GB", {
      timeZone: "UTC", month: "short", ...(range === "1Y" || range === "ALL" ? { year: "2-digit" } : { day: "numeric" }),
    }), hours, dayCount: 1 });
  }
  return { labels: [...buckets.values()].map(bucket => bucket.label),
    dataPoints: [...buckets.values()].map(bucket => Number((bucket.hours / bucket.dayCount).toFixed(2))) };
}
