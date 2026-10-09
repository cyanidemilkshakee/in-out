"""Persist employee dates that should skip irregularity alerts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "w1x2y3z4a5"
down_revision = "v0w1x2y3z4"
branch_labels = None
depends_on = None


def upgrade():
    # Existing rows represent explicit user rule overrides; preserve them as such.
    op.add_column("alert_rule_assignments", sa.Column(
        "rules_customized", sa.Boolean(), nullable=False, server_default=sa.text("true"),
    ))
    op.add_column("alert_rule_assignments", sa.Column(
        "irregularity_skip_dates",
        postgresql.JSONB(),
        nullable=False,
        server_default=sa.text("'[]'::jsonb"),
    ))
    op.create_check_constraint(
        "ck_alert_rule_assignments_skip_dates_array",
        "alert_rule_assignments",
        "jsonb_typeof(irregularity_skip_dates) = 'array'",
    )


def downgrade():
    op.drop_constraint("ck_alert_rule_assignments_skip_dates_array", "alert_rule_assignments", type_="check")
    op.drop_column("alert_rule_assignments", "irregularity_skip_dates")
    op.drop_column("alert_rule_assignments", "rules_customized")
