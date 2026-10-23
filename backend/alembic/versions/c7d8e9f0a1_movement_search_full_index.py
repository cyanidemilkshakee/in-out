"""Index the complete movement search expression, including its event ID.

This additive, transactional migration keeps the previous search index for
older application revisions. Rehearse on representative history and apply in
the documented writer maintenance window: acquiring its write-blocking index
lock may wait up to 5 seconds, and each statement is bounded to 120 seconds.
A failed build rolls back and leaves the existing index available.
"""
from alembic import op


revision = "c7d8e9f0a1"
down_revision = "b6c7d8e9f0"
branch_labels = None
depends_on = None


def _migration_bounds():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '120s'")


def upgrade():
    _migration_bounds()
    op.execute("""
        CREATE INDEX idx_movements_search_full_trgm
        ON movements USING gin (
            lower(
                id || ' ' ||
                coalesce(data->>'subjectName', '') || ' ' ||
                coalesce(data->>'barcode', '') || ' ' ||
                coalesce(data->>'checkpoint', '') || ' ' ||
                coalesce(data->>'reason', '')
            ) gin_trgm_ops
        )
    """)


def downgrade():
    _migration_bounds()
    op.execute("DROP INDEX idx_movements_search_full_trgm")
