"""Retain offline scans that cannot be safely replayed as new movements."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("critical_alert_triggers", sa.Column("zone_ids", postgresql.JSONB(astext_type=sa.Text()),
        nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.create_table(
        "offline_scan_reconciliations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True),
        sa.Column("subject_identity_at_capture", sa.String(), nullable=True),
        sa.Column("checkpoint_id", sa.String(), sa.ForeignKey("checkpoints.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("terminal_id", sa.String(), nullable=False),
        sa.Column("barcode", sa.String(length=64), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("direction", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("resolution_state", sa.String(), nullable=True),
        sa.Column("resolution_reason", sa.String(), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'resolved', 'dismissed')", name="ck_offline_reconciliation_status"),
        sa.CheckConstraint("resolution_state IS NULL OR resolution_state IN ('inside', 'outside')", name="ck_offline_reconciliation_state"),
        sa.CheckConstraint("direction IN ('entry', 'exit', 'unknown')", name="ck_offline_reconciliation_direction"),
    )
    op.create_index("idx_offline_reconciliation_pending", "offline_scan_reconciliations", ["status", "received_at"])
    op.create_table(
        "checkpoint_evaluation_status",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("last_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(length=128), nullable=True),
        sa.Column("checkpoints_evaluated", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("alerts_created", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("checkpoint_evaluation_status")
    op.drop_index("idx_offline_reconciliation_pending", table_name="offline_scan_reconciliations")
    op.drop_table("offline_scan_reconciliations")
    op.drop_column("critical_alert_triggers", "zone_ids")
