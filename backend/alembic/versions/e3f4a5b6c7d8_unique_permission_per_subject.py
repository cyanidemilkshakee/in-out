"""Ensure each subject has one authoritative access permission."""
from alembic import op

revision = "e3f4a5b6c7d8"
down_revision = "d2e8a3f4b1c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Older databases allowed duplicate permission rows. Keep the most
    # recently updated row (or the lexicographically first id when timestamps
    # are absent) before enforcing the one-to-one relationship.
    op.execute(
        """
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY subject_id
                   ORDER BY (data ->> 'updatedAt') DESC NULLS LAST, id
                 ) AS row_number
          FROM access_permissions
        )
        DELETE FROM access_permissions permissions
        USING ranked
        WHERE permissions.id = ranked.id AND ranked.row_number > 1
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_access_permissions_subject
        ON access_permissions (subject_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_access_permissions_subject")
