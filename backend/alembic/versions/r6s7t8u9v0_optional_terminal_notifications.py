"""Replace mandatory terminal acknowledgement metadata with optional dismissal.

An already closed notice stays closed. Decisions, movement evidence and audit
records are untouched; recent requests remain available in terminal history.
"""
from alembic import op
from sqlalchemy import text

revision = "r6s7t8u9v0"
down_revision = "q5r6s7t8u9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(text("""
        UPDATE permission_requests
        SET data = (data - 'terminalAcknowledgementRequired' - 'acknowledgedAt' - 'acknowledgedBy')
            || CASE WHEN NULLIF(data->>'acknowledgedAt', '') IS NOT NULL
                THEN jsonb_strip_nulls(jsonb_build_object(
                    'notificationDismissedAt', COALESCE(data->>'notificationDismissedAt', data->>'acknowledgedAt'),
                    'notificationDismissedBy', COALESCE(data->>'notificationDismissedBy', data->>'acknowledgedBy')
                ))
                ELSE '{}'::jsonb END
        WHERE data->>'type' = 'manual_override'
          AND (data ? 'terminalAcknowledgementRequired' OR data ? 'acknowledgedAt' OR data ? 'acknowledgedBy')
    """))


def downgrade() -> None:
    # There is no schema change to reverse. Preserve optional dismissal history.
    pass
