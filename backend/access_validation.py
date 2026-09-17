"""Validation shared by registry and permission writes."""
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException

FACILITY_TIMEZONE = timezone(timedelta(hours=5, minutes=30))


def validate_window(start, end):
    values = []
    for value in (start, end):
        if value in (None, ""):
            values.append(None)
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            values.append(parsed if parsed.tzinfo else parsed.replace(tzinfo=FACILITY_TIMEZONE))
        except (AttributeError, TypeError, ValueError):
            raise HTTPException(422, "Validity must be an ISO date-time")
    if all(values) and values[0] > values[1]:
        raise HTTPException(422, "Valid from must not be after valid to")


def validate_zones(zones):
    if not isinstance(zones, list) or len(zones) > 100 or any(not isinstance(zone, str) or not zone.strip() or len(zone) > 128 for zone in zones):
        raise HTTPException(422, "Zones must be a list of non-empty zone names")
    return list(dict.fromkeys(zone.strip() for zone in zones))
