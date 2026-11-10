"""Remove schema objects unused by the application.

The downgrade recreates the removed structures with synthesized timestamps and
HTTP status values; dropped historical values cannot be recovered.
"""
from alembic import op
import sqlalchemy as sa


revision = "b8c9d0e1f2"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("app_metadata")
    op.drop_column("scan_requests", "status_code")
    op.drop_column("critical_alert_triggers", "triggered_at")
    op.drop_column("movement_notes", "created_at")


def downgrade() -> None:
    op.create_table(
        "app_metadata",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
    )

    op.add_column("movement_notes", sa.Column(
        "created_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE movement_notes SET created_at = now() WHERE created_at IS NULL")
    op.alter_column("movement_notes", "created_at", nullable=False)

    op.add_column("critical_alert_triggers", sa.Column(
        "triggered_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("""
        UPDATE critical_alert_triggers AS marker
        SET triggered_at = COALESCE(alert.created_at, now())
        FROM alerts AS alert
        WHERE alert.id = marker.alert_id AND marker.triggered_at IS NULL
    """)
    op.execute("UPDATE critical_alert_triggers SET triggered_at = now() WHERE triggered_at IS NULL")
    op.alter_column("critical_alert_triggers", "triggered_at", nullable=False)

    op.add_column("scan_requests", sa.Column("status_code", sa.Integer(), nullable=True))
    op.execute("UPDATE scan_requests SET status_code = 200 WHERE status_code IS NULL")
    op.alter_column("scan_requests", "status_code", nullable=False)
