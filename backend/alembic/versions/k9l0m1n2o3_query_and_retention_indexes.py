"""Add indexes for bounded operational queries and retention cleanup."""
from alembic import op


revision = "k9l0m1n2o3"
down_revision = "j8k9l0m1n2o"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Trigram search keeps the movement log usable when a free-text search
    # grows beyond the small development dataset.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
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
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_permission_requests_pending_manual_review
        ON permission_requests (
            (data->>'checkpointId'), lower(data->>'barcode'),
            (data->>'direction'), created_at DESC
        )
        WHERE data->>'type' = 'manual_override'
          AND data->>'status' = 'pending'
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_notifications_unread_created_at
        ON notifications (created_at DESC)
        WHERE COALESCE(data->>'read', 'false') <> 'true'
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_audit_events_category_created_at
        ON audit_events ((data->>'category'), created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_alerts_open_created_at
        ON alerts (created_at DESC)
        WHERE data->>'status' = 'open'
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_scan_requests_created_at ON scan_requests (created_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_scan_requests_created_at")
    op.execute("DROP INDEX IF EXISTS idx_alerts_open_created_at")
    op.execute("DROP INDEX IF EXISTS idx_audit_events_category_created_at")
    op.execute("DROP INDEX IF EXISTS idx_notifications_unread_created_at")
    op.execute("DROP INDEX IF EXISTS idx_permission_requests_pending_manual_review")
    op.execute("DROP INDEX IF EXISTS idx_movements_search_trgm")
