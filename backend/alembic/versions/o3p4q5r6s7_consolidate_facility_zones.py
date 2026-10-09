"""Consolidate the facility's duplicate entrance and normalize zone references.

Only typed checkpoint/zone references are rewritten. Movement identities,
decisions, timestamps, live presence and retry fingerprints remain evidence.
The frozen mappings here intentionally do not import application helpers.
"""
import json

from alembic import op
from sqlalchemy import text

revision = "o3p4q5r6s7"
down_revision = "n2o3p4q5r6"
branch_labels = None
depends_on = None

_ZONES = ("public", "secure")
_ZONE_ALIASES = {"public": "public", "main entrance": "public", "secure": "secure", "server room": "secure"}
_ZONE_FIELDS = {"zones", "allowedZones", "requestedZones", "previousZones"}
_CHECKPOINT_FIELDS = {"checkpointId", "checkpoint_id", "entryCheckpointId", "exitCheckpointId"}
_CHECKPOINTS = (
    {"id": "cp-main", "name": "Main Entrance", "zone": "public"},
    {"id": "server-room", "name": "Server Room", "zone": "secure"},
)


def _normalize_zones(values):
    result = []
    for value in values:
        token = value.strip().casefold() if isinstance(value, str) else None
        if token == "all zones":
            result.extend(_ZONES)
        elif token in _ZONE_ALIASES:
            result.append(_ZONE_ALIASES[token])
        else:
            # Unrecognized historical values are evidence, never new grants.
            result.append(value)
    normalized = [zone for zone in _ZONES if zone in result]
    for value in result:
        if value not in normalized:
            normalized.append(value)
    return normalized


def _normalize_document(value):
    if isinstance(value, list):
        return [_normalize_document(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key in _CHECKPOINT_FIELDS and item == "main-gate":
            result[key] = "cp-main"
        elif key in _ZONE_FIELDS and isinstance(item, list):
            result[key] = _normalize_zones(item)
        elif key in {"zone", "allowedZone"} and isinstance(item, str):
            result[key] = _ZONE_ALIASES.get(item.strip().casefold(), item)
        elif key == "checkpoint" and item == "main-gate":
            result[key] = "Main Entrance"
        else:
            result[key] = _normalize_document(item)
    return result


def _decode(value):
    return json.loads(value) if isinstance(value, str) else value


def upgrade() -> None:
    connection = op.get_bind()
    checkpoints = {row["id"]: _decode(row["data"]) for row in connection.execute(
        text("SELECT id, data FROM checkpoints FOR UPDATE")
    ).mappings()}
    unexpected = set(checkpoints) - {"cp-main", "main-gate", "server-room"}
    if unexpected:
        raise RuntimeError("Unexpected checkpoints require explicit review before consolidation: " + ", ".join(sorted(unexpected)))
    # Never silently hide or remap live access to an unrelated zone. Completed
    # request/audit snapshots may retain historical values as evidence.
    for table, field, condition in (
        ("people", "allowedZones", "true"),
        ("hardware_assets", "allowedZones", "true"),
        ("access_permissions", "zones", "true"),
        ("permission_requests", "requestedZones", "data->>'status' = 'pending'"),
    ):
        for row in connection.execute(text(f"SELECT data FROM {table} WHERE {condition} FOR UPDATE")).mappings():
            zones = _decode(row["data"]).get(field, [])
            if zones is None:
                continue
            if not isinstance(zones, list) or any(
                not isinstance(zone, str) or zone.strip().casefold() not in {*_ZONE_ALIASES, "all zones"}
                for zone in zones
            ):
                raise RuntimeError(f"Unsupported live zones in {table}.{field} require explicit review before consolidation")
    # Keep the existing canonical entrance's operating mode/configuration. If
    # only the alias exists, transfer that configuration before deleting it.
    for checkpoint in _CHECKPOINTS:
        existing = checkpoints.get(checkpoint["id"], checkpoints.get("main-gate", {}) if checkpoint["id"] == "cp-main" else {})
        data = {**existing, **checkpoint}
        connection.execute(text("""
            INSERT INTO checkpoints (id, data) VALUES (:id, CAST(:data AS jsonb))
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
        """), {"id": checkpoint["id"], "data": json.dumps(data)})

    # The relational FK must be repaired before removing its checkpoint.
    connection.execute(text("UPDATE movements SET checkpoint_id = 'cp-main' WHERE checkpoint_id = 'main-gate'"))
    documents = (
        ("people", "subject_id", "data"),
        ("hardware_assets", "subject_id", "data"),
        ("access_permissions", "id", "data"),
        ("permission_requests", "id", "data"),
        ("movements", "id", "data"),
        ("scan_requests", "idempotency_key", "response_body"),
        ("presence_state", "subject_id", "entry_override"),
        ("audit_events", "id", "data"),
        ("alerts", "id", "data"),
    )
    for table, identity, column in documents:
        rows = connection.execute(text(f"SELECT {identity} AS identity, {column} AS document FROM {table} WHERE {column} IS NOT NULL FOR UPDATE")).mappings()
        for row in rows:
            original = _decode(row["document"])
            normalized = _normalize_document(original)
            if normalized != original:
                connection.execute(text(f"UPDATE {table} SET {column} = CAST(:document AS jsonb) WHERE {identity} = :identity"),
                    {"identity": row["identity"], "document": json.dumps(normalized)})
    connection.execute(text("DELETE FROM checkpoints WHERE id = 'main-gate'"))


def downgrade() -> None:
    # Reference consolidation is intentionally irreversible: the old alias
    # cannot be inferred for individual events without inventing history.
    pass
