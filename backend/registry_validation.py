"""Registry metadata validation shared by subject writes and permission grants."""
from typing import Any

from fastapi import HTTPException
from sqlalchemy import exc

from access_validation import validate_zones
from facility_zones import normalize_facility_document
from schemas import SubjectCreate
from subject_metadata import current_subject_metadata

METADATA_LIMITS = {
    "name": 100,
    "company": 120,
    "host": 100,
    "reason": 240,
    "purpose": 240,
    "owner": 100,
    "category": 80,
}


def validated_metadata(payload: SubjectCreate, *, known_zone_ids=None) -> dict[str, Any]:
    """Normalize user-entered metadata before it reaches the JSON columns."""
    incoming = current_subject_metadata(payload.kind, payload.data)
    incoming.pop("entryRestriction", None)
    incoming.pop("accessRevision", None)
    if payload.kind == "visitor":
        incoming.pop("phone", None)
    if "allowedZone" in incoming:
        zones = validate_zones([incoming["allowedZone"]], known_zone_ids=known_zone_ids)
        incoming["allowedZone"] = zones[0] if len(zones) == 1 else "All Zones"
    incoming = normalize_facility_document(incoming)
    if "allowedZones" in incoming:
        incoming["allowedZones"] = validate_zones(incoming["allowedZones"], known_zone_ids=known_zone_ids)
    for field, limit in METADATA_LIMITS.items():
        value = incoming.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail=f"{field} must be text")
        value = value.strip()
        if not value:
            raise HTTPException(status_code=422, detail=f"{field} cannot be empty")
        if len(value) > limit:
            raise HTTPException(status_code=422, detail=f"{field} must be {limit} characters or fewer")
        incoming[field] = value

    if payload.kind in {"employee", "visitor"}:
        for field in ("name", "host") if payload.kind == "visitor" else ("name",):
            if not str(incoming.get(field) or "").strip():
                raise HTTPException(status_code=422, detail=f"{field} is required")

    for field in ("validFrom", "validTo", "validUntil"):
        value = incoming.get(field)
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 40:
                raise HTTPException(status_code=422, detail=f"{field} must be a valid date-time")
            incoming[field] = value.strip()
    return incoming


def is_barcode_conflict(error: exc.IntegrityError) -> bool:
    original = error.orig
    constraint = getattr(getattr(original, "diag", None), "constraint_name", None)
    if constraint in {"uq_subjects_barcode_ci", "subjects_barcode_key"}:
        return True
    message = str(original or error).casefold()
    return "barcode" in message and ("duplicate" in message or "unique" in message)
