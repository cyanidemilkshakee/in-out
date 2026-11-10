"""Track the most recent heartbeat for each assigned terminal."""
from alembic import op
import sqlalchemy as sa


revision = "a6b7c8d9e0"
down_revision = "e9f0a1b2c3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("terminal_checkpoint_assignments",
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True))
    # Give already assigned terminals one five-minute grace period to report
    # their first heartbeat after deployment.
    op.execute("UPDATE terminal_checkpoint_assignments SET last_heartbeat_at = now()")


def downgrade():
    op.drop_column("terminal_checkpoint_assignments", "last_heartbeat_at")
