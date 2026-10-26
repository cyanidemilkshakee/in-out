"""Branch and numbered-checkpoint helpers shared by access policy and seed data."""
import hashlib
import itertools
import json
import re


FACILITY_ZONES = ("a", "b")
CHECKPOINTS = (
    {"id": "a-1", "name": "1", "zone": "a", "zoneId": "a", "number": 1,
     "gateType": "front_gate", "gateLabel": "Front Gate", "required": True, "buildingId": "a"},
    {"id": "a-2", "name": "2", "zone": "a", "zoneId": "a", "number": 2,
     "gateType": "back_gate", "gateLabel": "Back Gate", "required": False, "buildingId": "a"},
    {"id": "b-1", "name": "1", "zone": "b", "zoneId": "b", "number": 1,
     "gateType": "front_gate", "gateLabel": "Front Gate", "required": True, "buildingId": "b"},
    {"id": "b-2", "name": "2", "zone": "b", "zoneId": "b", "number": 2,
     "gateType": "back_gate", "gateLabel": "Back Gate", "required": False, "buildingId": "b"},
)
_ZONE_FIELDS = {"zones", "allowedZones", "requestedZones", "previousZones"}
_CHECKPOINT_FIELDS = {"checkpointId", "checkpoint_id", "entryCheckpointId", "exitCheckpointId"}
_ZONE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def canonical_checkpoint_id(value):
    """Checkpoint IDs are stable identities; no legacy location aliases remain."""
    return value


def normalize_zones(values, *, strict=True, known_zones=None):
    available = tuple(known_zones) if known_zones is not None else FACILITY_ZONES
    result = []
    for value in values:
        token = value.strip().casefold() if isinstance(value, str) else None
        if token == "all zones":
            result.extend(available)
        elif token and _ZONE_ID.fullmatch(token):
            if token in available or not strict:
                result.append(token)
            else:
                raise ValueError("Choose an active organization zone")
        elif strict:
            raise ValueError("Choose an active organization zone")
        else:
            result.append(value)
    canonical = [zone for zone in available if zone in result]
    for zone in result:
        if zone not in canonical:
            canonical.append(zone)
    return canonical


def normalize_facility_document(value, *, strict_zones=False):
    """Normalize typed branch/checkpoint references without rewriting free text."""
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
        elif key in {"zone", "zoneId", "allowedZone", "buildingId"} and isinstance(item, str):
            result[key] = item.strip().casefold() if _ZONE_ID.fullmatch(item.strip().casefold()) else item
        else:
            result[key] = normalize_facility_document(item, strict_zones=strict_zones)
    return result


def compatible_request_fingerprints(body, checkpoint_keys):
    """Keep the retry contract exact for the current checkpoint identity."""
    canonical = {**body, **{key: canonical_checkpoint_id(body[key]) for key in checkpoint_keys}}
    return [hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()]
