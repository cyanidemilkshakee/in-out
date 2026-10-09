"""Persist the one-visit exit entitlement of a manually approved entry."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "h6i7j8k9l0m1"
down_revision = "g5h6i7j8k9l0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("presence_state", sa.Column("entry_override", JSONB(), nullable=True))
    op.add_column("scan_requests", sa.Column("request_fingerprint", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("scan_requests", "request_fingerprint")
    op.drop_column("presence_state", "entry_override")
