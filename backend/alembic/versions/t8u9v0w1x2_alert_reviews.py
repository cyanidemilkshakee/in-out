"""Final alert reviews and subject warning reset epochs preserve history."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "t8u9v0w1x2"
down_revision = "s7t8u9v0w1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("alert_reviews",
        sa.Column("alert_id", sa.String(), primary_key=True),
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="RESTRICT")),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reviewed_by", sa.String(), nullable=False),
        sa.Column("alert_created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("alert_data", postgresql.JSONB(), nullable=False),
        sa.CheckConstraint("decision IN ('confirmed', 'excused')", name="ck_alert_reviews_decision"),
        sa.CheckConstraint("decision <> 'confirmed' OR subject_id IS NOT NULL", name="ck_confirmed_alert_subject"),
    )
    op.create_index("idx_alert_reviews_subject_reviewed", "alert_reviews", ["subject_id", "reviewed_at"])
    op.create_table("warning_resets",
        sa.Column("subject_id", sa.String(), sa.ForeignKey("subjects.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("reset_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reset_by", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
    )


def downgrade():
    op.drop_table("warning_resets")
    op.drop_index("idx_alert_reviews_subject_reviewed", table_name="alert_reviews")
    op.drop_table("alert_reviews")
