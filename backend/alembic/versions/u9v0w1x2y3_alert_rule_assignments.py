"""Store complete per-subject automated alert-rule selections."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "u9v0w1x2y3"
down_revision = "t8u9v0w1x2"
branch_labels = None
depends_on = None


def upgrade():
    # No rows are backfilled: absence preserves default inheritance for all
    # existing subjects, including employees registered after this migration.
    op.create_table("alert_rule_assignments",
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("rule_ids", postgresql.JSONB(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("jsonb_typeof(rule_ids) = 'array'", name="ck_alert_rule_assignments_array"),
        sa.CheckConstraint("revision > 0", name="ck_alert_rule_assignments_revision"),
    )


def downgrade():
    op.drop_table("alert_rule_assignments")
