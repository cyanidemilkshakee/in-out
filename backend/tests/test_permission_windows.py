"""Scheduled access shares strict facility calendar boundaries at creation and approval."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from access_validation import (
    ACCESS_START_GRACE,
    FACILITY_TIMEZONE,
    parse_validity,
    permission_horizon,
    validate_permission_window,
)


class PermissionWindowTests(unittest.TestCase):
    def assert_invalid(self, start, end, *, now, detail=None, allow_past_start=False):
        with self.assertRaises(HTTPException) as error:
            validate_permission_window(start, end, now=now, allow_past_start=allow_past_start)
        self.assertEqual(error.exception.status_code, 422)
        if detail:
            self.assertIn(detail, error.exception.detail)

    def test_naive_values_mean_facility_time_and_aware_values_preserve_their_instant(self):
        expected = datetime(2026, 10, 6, 6, 30, tzinfo=timezone.utc)
        for value in ("2026-10-06T12:00", "2026-10-06T12:00:00+05:30", "2026-10-06T06:30:00Z", "2026-10-06T08:30:00+02:00"):
            with self.subTest(value=value):
                self.assertEqual(parse_validity(value), expected)
        self.assertEqual(parse_validity("2026-10-06T12:00").tzinfo, FACILITY_TIMEZONE)
        self.assertEqual(parse_validity("2024-02-29T00:00:00.123456").microsecond, 123456)

    def test_invalid_calendar_dates_and_times_never_roll_into_another_day(self):
        values = (None, 123, "", "2026-02-29T12:00", "2024-02-30T12:00", "2026-04-31T12:00", "2026-13-01T12:00", "2026-00-01T12:00", "2026-01-00T12:00", "2026-01-01T24:00", "2026-01-01T12:60", "2026-01-01T12:00:60", "2026-01-01", "2026-01-01 12:00", "2026-01-01T12:00:00+24:00", "0000-01-01T12:00")
        for value in values:
            with self.subTest(value=value), self.assertRaises(HTTPException) as error:
                parse_validity(value)
            self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(parse_validity("2024-02-29T12:00").day, 29)

    def test_six_calendar_months_clamp_month_end_and_preserve_facility_wall_time(self):
        cases = (
            ("2026-08-31T23:15:30.123456+05:30", "2027-02-28T23:15:30.123456+05:30"),
            ("2023-08-31T23:15:30+05:30", "2024-02-29T23:15:30+05:30"),
            ("2026-01-31T09:45:00+05:30", "2026-07-31T09:45:00+05:30"),
            ("2026-08-31T21:00:00Z", "2027-03-01T02:30:00+05:30"),
        )
        for start, end in cases:
            with self.subTest(start=start):
                self.assertEqual(permission_horizon(parse_validity(start)), parse_validity(end))

    def test_start_grace_is_inclusive_and_uses_the_exact_instant(self):
        now = parse_validity("2026-10-06T12:00:00.250000+05:30")
        earliest = now - ACCESS_START_GRACE
        end = now + timedelta(hours=1)
        self.assertIsNone(validate_permission_window(earliest.isoformat(), end.isoformat(), now=now))
        self.assert_invalid((earliest - timedelta(microseconds=1)).isoformat(), end.isoformat(), now=now, detail="Valid from")
        self.assertIsNone(validate_permission_window(now.isoformat(), end.isoformat(), now=now))

    def test_end_must_be_after_start_and_strictly_after_now(self):
        now = parse_validity("2026-10-06T12:00")
        start = now + timedelta(hours=1)
        self.assert_invalid(start.isoformat(), start.isoformat(), now=now, detail="after valid from")
        self.assert_invalid(start.isoformat(), now.isoformat(), now=now, detail="after valid from")
        self.assert_invalid((now - timedelta(minutes=1)).isoformat(), now.isoformat(), now=now, detail="future")
        self.assertIsNone(validate_permission_window(now.isoformat(), (now + timedelta(microseconds=1)).isoformat(), now=now))

    def test_exact_horizon_is_allowed_but_one_microsecond_beyond_is_rejected(self):
        now = parse_validity("2026-08-31T23:15:30+05:30")
        horizon = permission_horizon(now)
        self.assertIsNone(validate_permission_window(now.isoformat(), horizon.isoformat(), now=now))
        self.assert_invalid(now.isoformat(), (horizon + timedelta(microseconds=1)).isoformat(), now=now, detail="six months")
        self.assert_invalid((horizon + timedelta(microseconds=1)).isoformat(), (horizon + timedelta(seconds=1)).isoformat(), now=now, detail="six months")

    def test_approval_can_retain_a_past_start_but_never_revive_expired_or_over_horizon_access(self):
        now = parse_validity("2026-10-06T12:00")
        old_start = parse_validity("2024-01-01T00:00")
        future_end = now + timedelta(hours=1)
        self.assertIsNone(validate_permission_window(old_start.isoformat(), future_end.isoformat(), now=now, allow_past_start=True))
        self.assert_invalid(old_start.isoformat(), future_end.isoformat(), now=now, detail="Valid from")
        for end in (now, now - timedelta(microseconds=1)):
            with self.subTest(end=end):
                self.assert_invalid(old_start.isoformat(), end.isoformat(), now=now, detail="future", allow_past_start=True)
        self.assert_invalid(old_start.isoformat(), (permission_horizon(now) + timedelta(microseconds=1)).isoformat(), now=now, detail="six months", allow_past_start=True)


if __name__ == "__main__":
    unittest.main()
