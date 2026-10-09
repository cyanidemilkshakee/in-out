import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_START_GRACE_MS,
  accessDateTimeLimits,
  accessWindowBounds,
  addFacilityCalendarMonths,
  facilityToday,
  historicalDateTimeLimits,
  parseFacilityDate,
  parseFacilityDateTime,
  validateAccessWindow,
  validateHistoricalDateRange,
  validateHistoricalDateTimeRange,
} from "../lib/dateTimeValidation";

test("strict facility parsing rejects impossible dates and times without rollover", () => {
  for (const value of ["2026-02-29T10:00", "2024-02-30T10:00", "2026-04-31T10:00", "2026-13-01T10:00", "2026-00-01T10:00", "2026-01-00T10:00", "2026-01-01T24:00", "2026-01-01T12:60", "2026-01-01T12:00:00", "invalid", ""]) {
    assert.equal(parseFacilityDateTime(value), undefined, value);
  }
  assert.equal(parseFacilityDateTime("2024-02-29T00:00"), Date.parse("2024-02-28T18:30:00Z"));
  assert.equal(parseFacilityDate("2024-02-29"), Date.parse("2024-02-28T18:30:00Z"));
  assert.equal(parseFacilityDate("2026-02-29"), undefined);
  assert.notEqual(parseFacilityDate("0001-01-01"), undefined);
  assert.equal(parseFacilityDate("0000-01-01"), undefined);
});

test("six calendar months preserve facility time and clamp month ends, including leap years", () => {
  assert.equal(addFacilityCalendarMonths(new Date("2026-08-31T23:15:00+05:30"), 6).toISOString(), "2027-02-28T17:45:00.000Z");
  assert.equal(addFacilityCalendarMonths(new Date("2023-08-31T23:15:00+05:30"), 6).toISOString(), "2024-02-29T17:45:00.000Z");
  assert.equal(addFacilityCalendarMonths(new Date("2026-01-31T09:45:00+05:30"), 6).toISOString(), "2026-07-31T04:15:00.000Z");
  const now = new Date("2026-08-31T23:15:30+05:30");
  assert.deepEqual(accessWindowBounds(now), { min: "2026-08-31T23:10", max: "2027-02-28T23:15", defaultStart: "2026-08-31T23:16" });
});

test("access validates exact grace, future end, strict ordering and inclusive six-month limit", () => {
  const now = new Date("2026-08-31T23:15:00+05:30");
  assert.equal(ACCESS_START_GRACE_MS, 300_000);
  assert.deepEqual(validateAccessWindow("2026-08-31T23:10", "2027-02-28T23:15", now), {});
  assert.ok(validateAccessWindow("2026-08-31T23:09", "2026-09-01T00:00", now).start);
  assert.ok(validateAccessWindow("2026-08-31T23:16", "2027-02-28T23:16", now).end);
  assert.ok(validateAccessWindow("2027-03-01T00:00", "2027-03-01T01:00", now).start);
  assert.ok(validateAccessWindow("2026-08-31T23:10", "2026-08-31T23:15", now).end);
  assert.ok(validateAccessWindow("2026-09-01T00:00", "2026-09-01T00:00", now).end);
  assert.ok(validateAccessWindow("2026-09-01T01:00", "2026-09-01T00:00", now).end);
  assert.ok(validateAccessWindow("2026-08-31T23:10", "2026-09-01T00:00", new Date(now.getTime() + 1)).start, "grace compares the exact instant");
});

test("native access limits block equal endpoints and restrict both calendars to six months", () => {
  const now = new Date("2026-10-06T12:00:30+05:30");
  const limits = accessDateTimeLimits("2026-10-06T14:00", "2026-10-06T15:00", now);
  assert.deepEqual(limits, { start: { min: "2026-10-06T11:55", max: "2026-10-06T14:59" }, end: { min: "2026-10-06T14:01", max: "2027-04-06T12:00" } });
  assert.equal(accessDateTimeLimits("", "", now).end.min, "2026-10-06T12:01");
});

test("historical date ranges allow past dates, open endpoints, same-day ranges and reject future or inverted dates", () => {
  const now = new Date("2026-10-05T20:00:00Z");
  assert.equal(facilityToday(now), "2026-10-06");
  assert.deepEqual(validateHistoricalDateRange("1999-01-01", "2026-10-06", now), {});
  assert.deepEqual(validateHistoricalDateRange("", "", now), {});
  assert.deepEqual(validateHistoricalDateRange("2026-10-06", "2026-10-06", now), {});
  assert.ok(validateHistoricalDateRange("2026-10-07", "", now).start);
  assert.ok(validateHistoricalDateRange("", "2026-10-07", now).end);
  assert.ok(validateHistoricalDateRange("2026-10-06", "2026-10-05", now).end);
  assert.ok(validateHistoricalDateRange("2026-02-29", "2026-10-05", now).start);
});

test("completed visits use facility timezone, permit any valid past date, and require exit after entry capped at now", () => {
  const now = new Date("2026-10-06T12:00:30+05:30");
  assert.deepEqual(validateHistoricalDateTimeRange("1999-01-01T08:00", "2026-10-06T12:00", now), {});
  assert.ok(validateHistoricalDateTimeRange("2026-10-06T12:01", "2026-10-06T12:02", now).start);
  assert.ok(validateHistoricalDateTimeRange("2026-10-06T10:00", "2026-10-06T12:01", now).end);
  assert.ok(validateHistoricalDateTimeRange("2026-10-06T10:00", "2026-10-06T10:00", now).end);
  assert.ok(validateHistoricalDateTimeRange("2026-02-29T08:00", "2026-10-06T12:00", now).start);
  assert.deepEqual(historicalDateTimeLimits("2026-10-06T10:00", "2026-10-06T11:00", now), { start: { max: "2026-10-06T10:59" }, end: { min: "2026-10-06T10:01", max: "2026-10-06T12:00" } });
});
