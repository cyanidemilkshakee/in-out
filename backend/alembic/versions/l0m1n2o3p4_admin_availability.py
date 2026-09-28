"""Replace automatic local logout preferences with explicit availability."""
from alembic import op
import sqlalchemy as sa


revision = "l0m1n2o3p4"
down_revision = "k9l0m1n2o3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("admin_accounts", sa.Column("offline_until", sa.DateTime(timezone=True), nullable=True))
    op.drop_column("admin_accounts", "auto_lock")


def downgrade() -> None:
    op.add_column("admin_accounts", sa.Column("auto_lock", sa.String(), nullable=False, server_default="15"))
    op.drop_column("admin_accounts", "offline_until")
