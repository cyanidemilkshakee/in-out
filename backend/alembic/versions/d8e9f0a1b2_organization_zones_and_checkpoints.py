"""Convert the legacy facility zones into organization branches.

Phase 2's public/Main Entrance and secure/Server Room locations map to the
initial Phase 3 branches A and B. Existing checkpoint IDs and operational
records remain intact; only typed zone references are normalized.
"""
import json
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision = "d8e9f0a1b2"
down_revision = "c7d8e9f0a1"
branch_labels = None
depends_on = None

_DEFAULT_ZONES = (("a", "A"), ("b", "B"))
_ZONE_MAP = {
    "a": "a", "zone a": "a", "public": "a", "main entrance": "a", "main-building": "a",
    "b": "b", "zone b": "b", "secure": "b", "server room": "b", "server-room-building": "b",
}
_ZONE_ARRAY_FIELDS = {"zones", "allowedZones", "requestedZones", "previousZones"}
_ZONE_VALUE_FIELDS = {"zone", "zoneId", "allowedZone", "buildingId"}
_CHECKPOINT_FIELDS = {"checkpointId", "checkpoint_id", "entryCheckpointId", "exitCheckpointId"}
_JSON_DOCUMENTS = (
    ("people", "subject_id", "data"),
    ("hardware_assets", "subject_id", "data"),
    ("access_permissions", "id", "data"),
    ("permission_requests", "id", "data"),
    ("movements", "id", "data"),
    ("scan_requests", "idempotency_key", "response_body"),
    ("presence_state", "subject_id", "entry_override"),
    ("audit_events", "id", "data"),
    ("alerts", "id", "data"),
    ("alert_reviews", "alert_id", "alert_data"),
    ("event_outbox", "id", "payload"),
)


def _decode(value):
    return json.loads(value) if isinstance(value, str) else value


def _mapped_zone(value):
    if not isinstance(value, str):
        return None
    return _ZONE_MAP.get(value.strip().casefold())


def _checkpoint_zone(checkpoint_id, data):
    if checkpoint_id in {"cp-main", "main-gate"}:
        return "a"
    if checkpoint_id == "server-room":
        return "b"
    for field in ("zoneId", "zone", "buildingId"):
        zone_id = _mapped_zone(data.get(field))
        if zone_id:
            return zone_id
    raise RuntimeError(
        f"Checkpoint {checkpoint_id!r} has no recognized Phase 2 zone; "
        "the migration stopped before changing application records."
    )


def _normalize_document(value):
    if isinstance(value, list):
        return [_normalize_document(item) for item in value]
    if not isinstance(value, dict):
        return value

    result = {}
    for key, item in value.items():
        if key in _CHECKPOINT_FIELDS and item == "main-gate":
            result[key] = "cp-main"
        elif key in _ZONE_ARRAY_FIELDS and isinstance(item, list):
            zones = []
            for zone in item:
                if isinstance(zone, str) and zone.strip().casefold() == "all zones":
                    zones.extend(("a", "b"))
                else:
                    zones.append(_mapped_zone(zone) or zone)
            normalized_zones = []
            seen_strings = set()
            for zone in zones:
                if isinstance(zone, str):
                    if zone in seen_strings:
                        continue
                    seen_strings.add(zone)
                normalized_zones.append(zone)
            result[key] = normalized_zones
        elif key in _ZONE_VALUE_FIELDS and isinstance(item, str):
            result[key] = _mapped_zone(item) or item
        else:
            result[key] = _normalize_document(item)
    return result


def _checkpoint_document(zone_id, number, gate_type, required, source=None):
    source = dict(source or {})
    gate_label = "Front Gate" if gate_type == "front_gate" else "Back Gate" if gate_type == "back_gate" else ""
    name = source.get("name") or str(number)
    source.update({
        "name": name,
        "zone": zone_id,
        "zoneId": zone_id,
        "buildingId": zone_id,
        "checkpointNumber": number,
        "gateType": gate_type,
        "gateLabel": source.get("gateLabel") or gate_label,
        "required": required,
        "active": True,
    })
    return source


def _checkpoint_id(connection, preferred, occupied):
    if preferred not in occupied and not connection.scalar(
        text("SELECT EXISTS (SELECT 1 FROM checkpoints WHERE id = :id)"), {"id": preferred}
    ):
        return preferred
    suffix = 1
    while True:
        candidate = f"{preferred}-legacy-{suffix}"
        if candidate not in occupied and not connection.scalar(
            text("SELECT EXISTS (SELECT 1 FROM checkpoints WHERE id = :id)"), {"id": candidate}
        ):
            return candidate
        suffix += 1


def _map_json_documents(connection):
    for table, identity_column, json_column in _JSON_DOCUMENTS:
        rows = connection.execute(text(
            f"SELECT {identity_column} AS identity, {json_column} AS document "
            f"FROM {table} WHERE {json_column} IS NOT NULL FOR UPDATE"
        )).mappings()
        for row in rows:
            original = _decode(row["document"])
            normalized = _normalize_document(original)
            if normalized != original:
                connection.execute(text(
                    f"UPDATE {table} SET {json_column} = CAST(:document AS jsonb) "
                    f"WHERE {identity_column} = :identity"
                ), {"document": json.dumps(normalized), "identity": row["identity"]})


def upgrade() -> None:
    connection = op.get_bind()
    op.create_table(
        "organization_zones",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False, unique=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "zone_admin_assignments",
        sa.Column("admin_subject", sa.String(), primary_key=True),
        sa.Column("zone_id", sa.String(), sa.ForeignKey("organization_zones.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("assigned_by", sa.String(), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_zone_admin_assignments_zone", "zone_admin_assignments", ["zone_id", "admin_subject"])
    op.bulk_insert(
        sa.table("organization_zones", sa.column("id", sa.String()), sa.column("name", sa.String())),
        [{"id": zone_id, "name": name} for zone_id, name in _DEFAULT_ZONES],
    )

    op.add_column("checkpoints", sa.Column("zone_id", sa.String(), nullable=True))
    op.add_column("checkpoints", sa.Column("number", sa.Integer(), nullable=True))
    op.add_column("checkpoints", sa.Column("gate_type", sa.String(), nullable=True))
    op.add_column("checkpoints", sa.Column("required", sa.Boolean(), nullable=True))
    op.add_column("checkpoints", sa.Column("active", sa.Boolean(), nullable=True))

    rows = connection.execute(text("SELECT id, data FROM checkpoints ORDER BY id FOR UPDATE")).mappings().all()
    groups = {zone_id: [] for zone_id, _ in _DEFAULT_ZONES}
    occupied = {row["id"] for row in rows}
    for row in rows:
        data = _decode(row["data"]) or {}
        zone_id = _checkpoint_zone(row["id"], data)
        groups[zone_id].append({"id": row["id"], "data": data})

    now = datetime.now(timezone.utc).isoformat()
    for zone_id, _zone_name in _DEFAULT_ZONES:
        checkpoints = groups[zone_id]
        front_candidates = [item for item in checkpoints if item["id"] in ({"cp-main", "main-gate"} if zone_id == "a" else {"server-room"})
                           or item["data"].get("gateType") == "front_gate"]
        back_candidates = [item for item in checkpoints if item["data"].get("gateType") == "back_gate"]
        front = front_candidates[0] if front_candidates else None
        back = next((item for item in back_candidates if item is not front), None)
        remaining = [item for item in checkpoints if item is not front and item is not back]
        remaining.sort(key=lambda item: (str(item["data"].get("createdAt") or ""), item["id"]))

        assigned = []
        if front:
            assigned.append((front, 1, "front_gate", True))
        if back:
            assigned.append((back, 2, "back_gate", False))
        assigned.extend((item, index + 3, "custom", False) for index, item in enumerate(remaining))

        for item, number, gate_type, required in assigned:
            data = _checkpoint_document(zone_id, number, gate_type, required, item["data"])
            connection.execute(text("""
                UPDATE checkpoints
                SET data = CAST(:data AS jsonb), zone_id = :zone_id, number = :number,
                    gate_type = :gate_type, required = :required, active = true
                WHERE id = :id
            """), {"id": item["id"], "data": json.dumps(data), "zone_id": zone_id,
                "number": number, "gate_type": gate_type, "required": required})

        if front is None:
            checkpoint_id = _checkpoint_id(connection, f"{zone_id}-1", occupied)
            occupied.add(checkpoint_id)
            data = _checkpoint_document(zone_id, 1, "front_gate", True,
                {"mode": "auto", "online": True, "createdAt": now})
            connection.execute(text("""
                INSERT INTO checkpoints (id, data, zone_id, number, gate_type, required, active)
                VALUES (:id, CAST(:data AS jsonb), :zone_id, 1, 'front_gate', true, true)
            """), {"id": checkpoint_id, "data": json.dumps(data), "zone_id": zone_id})

        if back is None:
            checkpoint_id = _checkpoint_id(connection, f"{zone_id}-2", occupied)
            occupied.add(checkpoint_id)
            data = _checkpoint_document(zone_id, 2, "back_gate", False,
                {"mode": "auto", "online": True, "createdAt": now})
            connection.execute(text("""
                INSERT INTO checkpoints (id, data, zone_id, number, gate_type, required, active)
                VALUES (:id, CAST(:data AS jsonb), :zone_id, 2, 'back_gate', false, true)
            """), {"id": checkpoint_id, "data": json.dumps(data), "zone_id": zone_id})

    _map_json_documents(connection)
    presence_rows = connection.execute(text(
        "SELECT subject_id, entry_building_id FROM presence_state "
        "WHERE entry_building_id IS NOT NULL FOR UPDATE"
    )).mappings()
    for row in presence_rows:
        zone_id = _mapped_zone(row["entry_building_id"])
        if zone_id and zone_id != row["entry_building_id"]:
            connection.execute(text("UPDATE presence_state SET entry_building_id = :zone_id WHERE subject_id = :subject_id"),
                {"zone_id": zone_id, "subject_id": row["subject_id"]})

    op.alter_column("checkpoints", "zone_id", nullable=False)
    op.alter_column("checkpoints", "number", nullable=False)
    op.alter_column("checkpoints", "gate_type", nullable=False)
    op.alter_column("checkpoints", "required", nullable=False)
    op.alter_column("checkpoints", "active", nullable=False)
    op.create_foreign_key("fk_checkpoints_zone_id_organization_zones", "checkpoints", "organization_zones",
        ["zone_id"], ["id"], ondelete="RESTRICT")
    op.create_unique_constraint("uq_checkpoint_zone_number", "checkpoints", ["zone_id", "number"])
    op.create_check_constraint("ck_checkpoint_number_positive", "checkpoints", "number > 0")
    op.create_check_constraint("ck_checkpoint_gate_type", "checkpoints",
        "gate_type IN ('front_gate', 'back_gate', 'custom')")
    op.create_index("idx_checkpoints_zone_active", "checkpoints", ["zone_id", "active", "number"])
    op.create_index("uq_checkpoint_required_per_zone", "checkpoints", ["zone_id"], unique=True,
        postgresql_where=sa.text("required"))


def downgrade() -> None:
    raise RuntimeError("The branch-model migration is not safely reversible")
