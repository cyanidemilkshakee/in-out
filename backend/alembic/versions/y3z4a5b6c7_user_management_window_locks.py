"""Persist revoked administrator reauthentication windows."""
from alembic import op
import sqlalchemy as sa

revision = "y3z4a5b6c7"
down_revision = "x2y3z4a5b6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("user_management_window_locks",
        sa.Column("keycloak_subject", sa.String(), nullable=False),
        sa.Column("window_id", sa.String(36), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("keycloak_subject", "window_id"))
    op.create_index("idx_user_management_locks_expiry", "user_management_window_locks", ["expires_at"])


def downgrade():
    op.drop_table("user_management_window_locks")
