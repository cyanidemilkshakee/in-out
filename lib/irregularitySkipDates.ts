const FACILITY_TIME_ZONE = "Asia/Kolkata";

export function irregularitySkipDateRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((value) => value.type === type)?.value ?? "00";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const [year, month, day] = today.split("-").map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 + 6, 1));
  const maxDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const max = `${targetMonth.getUTCFullYear()}-${String(targetMonth.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, maxDay)).padStart(2, "0")}`;
  return { today, max };
}

export function formatIrregularitySkipDate(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat(undefined, {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}
