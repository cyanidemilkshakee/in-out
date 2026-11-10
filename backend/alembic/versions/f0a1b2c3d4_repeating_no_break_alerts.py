"""Track six-hour no-break alert intervals for each continuous visit."""
from alembic import op
import sqlalchemy as sa

revision = "f0a1b2c3d4"
down_revision = "e9f0a1b2c3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "presence_state",
        sa.Column("no_break_alerted_interval", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade():
    op.drop_column("presence_state", "no_break_alerted_interval")
