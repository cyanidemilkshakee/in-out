"""Bind profile preferences to the signed-in Keycloak identity."""
from alembic import op
import sqlalchemy as sa

revision = "i7j8k9l0m1n2"
down_revision = "h6i7j8k9l0m1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("admin_accounts", sa.Column("keycloak_subject", sa.String(), nullable=True))
    op.create_index("uq_admin_accounts_keycloak_subject", "admin_accounts", ["keycloak_subject"], unique=True)
    op.execute("DROP INDEX IF EXISTS uq_admin_accounts_current")
    # Profile contact information is not an authentication identifier.
    op.execute("DROP INDEX IF EXISTS uq_admin_accounts_email_ci")
    op.execute("ALTER TABLE admin_accounts DROP CONSTRAINT IF EXISTS admin_accounts_email_key")


def downgrade() -> None:
    op.drop_index("uq_admin_accounts_keycloak_subject", table_name="admin_accounts")
    op.drop_column("admin_accounts", "keycloak_subject")
    # Keep legacy uniqueness relaxed: restoring it could discard valid profiles.
