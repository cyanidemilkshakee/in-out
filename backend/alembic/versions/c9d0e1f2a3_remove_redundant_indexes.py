"""Remove redundant and superseded indexes.

Index operations follow the active search_path so isolated-schema migrations
modify their own schema while normal deployments continue to target public.
"""
from alembic import op


revision = "c9d0e1f2a3"
down_revision = "b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_access_permissions_subject")
    op.execute("DROP INDEX IF EXISTS idx_movements_search_trgm")


def downgrade() -> None:
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_access_permissions_subject
        ON access_permissions (subject_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_movements_search_trgm
        ON movements USING gin (
            lower(
                coalesce(data->>'subjectName', '') || ' ' ||
                coalesce(data->>'barcode', '') || ' ' ||
                coalesce(data->>'checkpoint', '') || ' ' ||
                coalesce(data->>'reason', '')
            ) gin_trgm_ops
        )
    """)
