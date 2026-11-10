"""Validation shared by registry and permission writes."""
from datetime import datetime, timedelta, timezone
from calendar import monthrange
import re
from fastapi import HTTPException
from facility_zones import FACILITY_ZONES, canonical_checkpoint_id, normalize_zones
from models import Checkpoint, OrganizationZone
from sqlalchemy import select

FACILITY_TIMEZONE = timezone(timedelta(hours=5, minutes=30))
ACCESS_START_GRACE = timedelta(minutes=5)


def parse_validity(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
        r"T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,6})?)?"
        r"(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?", value
    ):
        raise HTTPException(422, "Validity must be an ISO date-time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=FACILITY_TIMEZONE)
    except ValueError:
        raise HTTPException(422, "Validity must be an ISO date-time")


def permission_horizon(now):
    local = now.astimezone(FACILITY_TIMEZONE)
    month_index = local.year * 12 + local.month - 1 + 6
    year, month = divmod(month_index, 12)
    month += 1
    return local.replace(year=year, month=month, day=min(local.day, monthrange(year, month)[1]))


def validate_permission_window(start, end, *, now=None, allow_past_start=False, permanent=False):
    """Bound scheduled access at every write, including approval of saved requests."""
    now = now or datetime.now(timezone.utc)
    start_at = parse_validity(start)
    end_at = None if permanent and end in (None, "") else parse_validity(end)
    if end_at is not None and end_at <= start_at:
        raise HTTPException(422, "Valid to must be after valid from")
    if end_at is not None and end_at <= now:
        raise HTTPException(422, "Valid to must be in the future")
    if not allow_past_start and start_at < now - ACCESS_START_GRACE:
        raise HTTPException(422, "Valid from must be now or in the future")
    horizon = permission_horizon(now)
    if start_at > horizon or (end_at is not None and end_at > horizon):
        raise HTTPException(422, "Permissions can only be scheduled within the next six months")


def validate_window(start, end):
    values = []
    for value in (start, end):
        if value in (None, ""):
            values.append(None)
            continue
        try:
            values.append(parse_validity(value))
        except (AttributeError, TypeError, ValueError):
            raise HTTPException(422, "Validity must be an ISO date-time")
    if all(values) and values[0] >= values[1]:
        raise HTTPException(422, "Valid to must be after valid from")


def validate_zones(zones, *, known_zone_ids=None):
    if not isinstance(zones, list) or len(zones) > 100 or any(not isinstance(zone, str) or not zone.strip() or len(zone) > 128 for zone in zones):
        raise HTTPException(422, "Zones must be a list of valid organization zone IDs")
    try:
        return normalize_zones(
            zones,
            known_zones=FACILITY_ZONES if known_zone_ids is None else known_zone_ids,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


async def validate_registered_zones(db, zones):
    """Validate branch IDs against the active organization-zone registry."""
    result = await db.scalars(select(OrganizationZone.id).where(OrganizationZone.active.is_(True)))
    return validate_zones(zones, known_zone_ids=tuple(result.all()))


async def require_registered_checkpoint(db, value):
    """Validate a checkpoint reference against PostgreSQL's current registry."""
    if not isinstance(value, str):
        raise HTTPException(422, "Choose a registered checkpoint")
    checkpoint_id = canonical_checkpoint_id(value.strip())
    if (not checkpoint_id or len(checkpoint_id) > 64
            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", checkpoint_id)):
        raise HTTPException(422, "Choose a registered checkpoint")
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if checkpoint is None or getattr(checkpoint, "active", True) is False:
        raise HTTPException(422, "Checkpoint not registered")
    zone_id = getattr(checkpoint, "zone_id", None)
    if zone_id:
        # Keep the zone row shared-locked through the caller's transaction.
        # Zone retirement takes an exclusive lock before checking assignments,
        # pending requests and active visits, closing the scan/delete race.
        zone = await db.scalar(select(OrganizationZone).where(
            OrganizationZone.id == zone_id).with_for_update(read=True))
        if zone is None or getattr(zone, "active", True) is False:
            raise HTTPException(422, "Checkpoint is in an inactive organization zone")
    return checkpoint_id


async def validate_registered_checkpoints(db, values):
    """Validate a bounded checkpoint scope and keep its zones active through commit."""
    if (not isinstance(values, list) or not values or len(values) > 16
            or any(not isinstance(value, str) or not value.strip() for value in values)):
        raise HTTPException(422, "Choose between one and 16 checkpoints")
    checkpoint_ids = [canonical_checkpoint_id(value.strip()) for value in values]
    if len(set(checkpoint_ids)) != len(checkpoint_ids) or any(
        len(value) > 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value)
        for value in checkpoint_ids
    ):
        raise HTTPException(422, "Checkpoint access must contain unique registered checkpoint IDs")

    result = await db.scalars(select(Checkpoint).where(
        Checkpoint.id.in_(checkpoint_ids), Checkpoint.active.is_not(False)
    ).order_by(Checkpoint.id))
    checkpoints = {item.id: item for item in result.all()}
    if len(checkpoints) != len(checkpoint_ids):
        raise HTTPException(422, "One or more selected checkpoints are unavailable")

    zone_ids = {item.zone_id for item in checkpoints.values() if item.zone_id}
    if any(not item.zone_id for item in checkpoints.values()):
        raise HTTPException(422, "Every selected checkpoint must belong to an active organization zone")
    active_zones = await db.scalars(select(OrganizationZone.id).where(
        OrganizationZone.id.in_(zone_ids), OrganizationZone.active.is_(True)
    ).order_by(OrganizationZone.id).with_for_update(read=True))
    if set(active_zones.all()) != zone_ids:
        raise HTTPException(422, "One or more selected checkpoints are in an inactive organization zone")
    return [checkpoints[checkpoint_id] for checkpoint_id in checkpoint_ids]


async def validate_checkpoint_scopes(db, scopes, allowed_zone_ids):
    """Validate per-zone checkpoint policy; None means all checkpoints in that zone."""
    from fastapi import HTTPException
    if not isinstance(scopes, dict) or len(scopes) > 100:
        raise HTTPException(422, "Checkpoint scopes must map registered zones to checkpoint lists")
    zones = set(await validate_registered_zones(db, list(allowed_zone_ids)))
    normalized = {}
    checkpoint_ids = []
    for zone_id, values in scopes.items():
        if not isinstance(zone_id, str) or zone_id not in zones:
            raise HTTPException(422, "Checkpoint scopes must belong to the approved zones")
        if values is None:
            normalized[zone_id] = None
            continue
        if (not isinstance(values, list) or len(values) > 1000
                or any(not isinstance(value, str) or not value.strip() for value in values)
                or len(set(values)) != len(values)):
            raise HTTPException(422, "Checkpoint scope lists must contain unique registered IDs")
        normalized[zone_id] = list(values)
        checkpoint_ids.extend(values)
    if checkpoint_ids:
        rows = (await db.execute(select(Checkpoint.id, Checkpoint.zone_id).where(
            Checkpoint.id.in_(set(checkpoint_ids)), Checkpoint.active.is_(True)
        ))).all()
        found = {checkpoint_id: zone_id for checkpoint_id, zone_id in rows}
        if len(found) != len(set(checkpoint_ids)) or any(
            found.get(checkpoint_id) != zone_id
            for zone_id, values in normalized.items() if isinstance(values, list)
            for checkpoint_id in values
        ):
            raise HTTPException(422, "One or more checkpoint scopes are unavailable or belong to another zone")
    return normalized
