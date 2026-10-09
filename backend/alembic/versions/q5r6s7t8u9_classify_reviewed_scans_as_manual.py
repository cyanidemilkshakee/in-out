"""Classify finalized manual reviews consistently in counters and movement JSON.

Only original scans bearing server-created review evidence are corrected.
Their identities, decisions, timestamps, presence, and retry snapshots remain
unchanged. Preserve the initial classification for the historical evidence.
"""
from alembic import op
from sqlalchemy import text

revision = "q5r6s7t8u9"
down_revision = "p4q5r6s7t8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(text("""
        UPDATE movements
        SET data = data || jsonb_build_object(
                'scanType', 'manual',
                'initialScanType', COALESCE(data->>'initialScanType', scan_type)
            ),
            scan_type = 'manual'
        WHERE result IN ('approved', 'denied')
          AND NULLIF(data->>'overrideRequestId', '') IS NOT NULL
          AND NULLIF(data->>'manualReviewedAt', '') IS NOT NULL
          AND (scan_type <> 'manual' OR data->>'scanType' IS DISTINCT FROM 'manual')
    """))


def downgrade() -> None:
    # This corrects classification data; there is no schema change to reverse.
    pass
