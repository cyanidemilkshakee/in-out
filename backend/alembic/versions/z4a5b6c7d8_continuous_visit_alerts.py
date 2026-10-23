"""Track continuous visits and retain visitor-overstay alert deduplication."""
from alembic import op
import sqlalchemy as sa

revision = "z4a5b6c7d8"
down_revision = "y3z4a5b6c7"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("presence_state", sa.Column("entry_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("presence_state", sa.Column("visitor_overstay_alerted_entry_at", sa.DateTime(timezone=True), nullable=True))
    # The last approved scan is a conservative baseline for existing visits;
    # missing history cannot establish a start time and remains unknown.
    op.execute("UPDATE presence_state SET entry_started_at = last_scan_timestamp WHERE state = 'inside'")


def downgrade():
    op.drop_column("presence_state", "visitor_overstay_alerted_entry_at")
    op.drop_column("presence_state", "entry_started_at")
