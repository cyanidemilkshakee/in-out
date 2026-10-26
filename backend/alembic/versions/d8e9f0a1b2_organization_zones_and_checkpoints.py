"""Create fresh A/B branches and numbered gate checkpoints.

This release deliberately does not infer a branch assignment for the old
public/secure model. Upgrade must follow an explicitly targeted reset of the
InOut application database. The migration refuses to proceed if application
records remain; it never truncates operational data or Temporal history.
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision = "d8e9f0a1b2"
down_revision = "c7d8e9f0a1"
branch_labels = None
depends_on = None

_APPLICATION_TABLES = (
    "subjects", "people", "hardware_assets", "terminal_checkpoint_assignments",
    "presence_state", "scan_requests", "access_permissions", "movements",
    "permission_requests", "alerts", "alert_rules", "critical_entry_restrictions",
    "critical_alert_triggers", "alert_reviews", "warning_resets", "audit_events",
    "movement_notes", "admin_accounts", "user_management_window_locks",
    # event_stream_state is initialized with its single cursor row by an
    # earlier migration even on a clean database, so it is not user data.
    "alert_rule_assignments", "event_outbox",
)

_DEFAULT_ZONES = (("a", "A"), ("b", "B"))
_DEFAULT_CHECKPOINTS = (
    ("a-1", "a", 1, "front_gate", True, "1", "Front Gate"),
    ("a-2", "a", 2, "back_gate", False, "2", "Back Gate"),
    ("b-1", "b", 1, "front_gate", True, "1", "Front Gate"),
    ("b-2", "b", 2, "back_gate", False, "2", "Back Gate"),
)


def upgrade() -> None:
    connection = op.get_bind()
    populated = []
    for table in _APPLICATION_TABLES:
        if connection.scalar(text(f"SELECT EXISTS (SELECT 1 FROM {table} LIMIT 1)")):
            populated.append(table)
    if populated:
        raise RuntimeError(
            "The old public/secure records cannot be assigned to organization branches safely. "
            "Reset only the disposable InOut application database, then rerun this migration. "
            "Populated tables: " + ", ".join(populated)
        )

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

    # Older reference-seed migrations may have inserted two static
    # checkpoints. The guard above proves they have no assignments/history.
    connection.execute(text("DELETE FROM checkpoints"))
    op.add_column("checkpoints", sa.Column("zone_id", sa.String(), nullable=True))
    op.add_column("checkpoints", sa.Column("number", sa.Integer(), nullable=True))
    op.add_column("checkpoints", sa.Column("gate_type", sa.String(), nullable=True))
    op.add_column("checkpoints", sa.Column("required", sa.Boolean(), nullable=True))
    op.add_column("checkpoints", sa.Column("active", sa.Boolean(), nullable=True))

    for checkpoint_id, zone_id, number, gate_type, required, name, label in _DEFAULT_CHECKPOINTS:
        data = {
            "name": name,
            "mode": "auto",
            "zone": zone_id,
            "zoneId": zone_id,
            "buildingId": zone_id,
            "checkpointNumber": number,
            "gateType": gate_type,
            "gateLabel": label,
            "required": required,
            "active": True,
            "online": True,
        }
        connection.execute(text("""
            INSERT INTO checkpoints (id, data, zone_id, number, gate_type, required, active)
            VALUES (:id, CAST(:data AS jsonb), :zone_id, :number, :gate_type, :required, true)
        """), {"id": checkpoint_id, "data": json.dumps(data), "zone_id": zone_id,
            "number": number, "gate_type": gate_type, "required": required})

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
