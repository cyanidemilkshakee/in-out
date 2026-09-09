"""Remove the duplicate application password store.

Keycloak is the sole authentication provider; admin_accounts stores only profile data.
"""
from alembic import op

revision = "d2e8a3f4b1c9"
down_revision = "c91b6d7e8f2a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE admin_accounts DROP COLUMN password_hash")


def downgrade() -> None:
    op.execute("ALTER TABLE admin_accounts ADD COLUMN password_hash text NOT NULL DEFAULT ''")
