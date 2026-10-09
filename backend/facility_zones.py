"""The facility's two checkpoints, stable zone IDs, and legacy aliases."""
import hashlib
import itertools
import json

FACILITY_ZONES = ("public", "secure")
CHECKPOINT_IDS = ("cp-main", "server-room")
CHECKPOINTS = (
    {"id": "cp-main", "name": "Main Entrance", "zone": "public", "buildingId": "main-building"},
    {"id": "server-room", "name": "Server Room", "zone": "secure", "buildingId": "server-room-building"},
)
BUILDING_NAMES = {
    "main-building": "Main Entrance",
    "server-room-building": "Server Room",
}
_ZONE_ALIASES = {"public": "public", "main entrance": "public", "secure": "secure", "server room": "secure"}
_ZONE_FIELDS = {"zones", "allowedZones", "requestedZones", "previousZones"}
_CHECKPOINT_FIELDS = {"checkpointId", "checkpoint_id", "entryCheckpointId", "exitCheckpointId"}


def canonical_checkpoint_id(value):
    """Keep unrelated historical IDs intact; write validation is separate."""
    return "cp-main" if value == "main-gate" else value


def building_for_checkpoint(checkpoint_id):
    """Return the building identity for a checkpoint, independently of zone access."""
    checkpoint_id = canonical_checkpoint_id(checkpoint_id)
    return next((item["buildingId"] for item in CHECKPOINTS if item["id"] == checkpoint_id), None)


def normalize_zones(values, *, strict=True):
    result = []
    for value in values:
        token = value.strip().casefold() if isinstance(value, str) else None
        if token == "all zones":
            result.extend(FACILITY_ZONES)
        elif token in _ZONE_ALIASES:
            result.append(_ZONE_ALIASES[token])
        elif strict:
            raise ValueError("Choose Main Entrance or Server Room")
        else:
            result.append(value)
    # Stable canonical ordering prevents equivalent selections producing
    # different access snapshots; unrelated history remains unchanged.
    canonical = [zone for zone in FACILITY_ZONES if zone in result]
    for zone in result:
        if zone not in canonical:
            canonical.append(zone)
    return canonical


def normalize_facility_document(value, *, strict_zones=False):
    """Repair typed references in nested snapshots without changing evidence."""
    if isinstance(value, list):
        return [normalize_facility_document(item, strict_zones=strict_zones) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in _CHECKPOINT_FIELDS:
            result[key] = canonical_checkpoint_id(item)
        elif key in _ZONE_FIELDS and isinstance(item, list):
            result[key] = normalize_zones(item, strict=strict_zones)
        elif key in {"zone", "allowedZone"} and isinstance(item, str):
            token = item.strip().casefold()
            result[key] = _ZONE_ALIASES.get(token, item)
        elif key == "checkpoint" and item == "main-gate":
            result[key] = "Main Entrance"
        else:
            result[key] = normalize_facility_document(item, strict_zones=strict_zones)
    return result


def compatible_request_fingerprints(body, checkpoint_keys):
    """Accept old offline keys without weakening payload or actor checks.

    Hashes already persisted before consolidation cannot be reversed. Compare
    both spellings of the same checkpoint while keeping every other input
    byte-equivalent to the existing normalized fingerprint contract.
    """
    canonical = {**body, **{key: canonical_checkpoint_id(body[key]) for key in checkpoint_keys}}
    alias_keys = [key for key in checkpoint_keys if canonical[key] == "cp-main"]
    fingerprints = []
    for values in itertools.product(("cp-main", "main-gate"), repeat=len(alias_keys)):
        variant = {**canonical, **dict(zip(alias_keys, values))}
        fingerprints.append(hashlib.sha256(json.dumps(variant, sort_keys=True).encode()).hexdigest())
    return fingerprints
