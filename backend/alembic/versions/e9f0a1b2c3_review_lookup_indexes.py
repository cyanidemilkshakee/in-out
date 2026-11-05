"""Index review lookups and legacy manual-review movement joins."""
from alembic import op


revision = "e9f0a1b2c3"
down_revision = "d8e9f0a1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '120s'")
    op.execute("""
        CREATE INDEX idx_permission_requests_approved_manual_scan
        ON permission_requests (
            lower(data->>'barcode'),
            (data->>'checkpointId'),
            (data->>'direction'),
            created_at DESC,
            id DESC
        )
        WHERE data->>'type' = 'manual_override'
          AND data->>'status' = 'approved'
          AND data->>'consumedAt' IS NULL
    """)
    op.execute("""
        CREATE INDEX idx_permission_requests_manual_source_event
        ON permission_requests ((data->>'eventId'))
        WHERE data->>'type' = 'manual_override'
          AND data->>'eventId' IS NOT NULL
    """)
    op.execute("""
        CREATE INDEX idx_movements_manual_override_request
        ON movements ((data->>'overrideRequestId'))
        WHERE data->>'overrideRequestId' IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '120s'")
    op.execute("DROP INDEX idx_movements_manual_override_request")
    op.execute("DROP INDEX idx_permission_requests_manual_source_event")
    op.execute("DROP INDEX idx_permission_requests_approved_manual_scan")
