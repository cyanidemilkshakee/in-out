"""Allow manual review requests for unregistered barcodes."""
from alembic import op


revision = "f4a5b6c7d8e9"
down_revision = "e3f4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE permission_requests ALTER COLUMN subject_id DROP NOT NULL")
    # The ORM used to declare this column unique. Remove either PostgreSQL
    # representation so a subject can have more than one historical review.
    op.execute("ALTER TABLE permission_requests DROP CONSTRAINT IF EXISTS permission_requests_subject_id_key")
    op.execute("DROP INDEX IF EXISTS ix_permission_requests_subject_id")
    # Manual reviews now live in permission_requests, never in Alerts.
    op.execute(
        """
        DELETE FROM alert_rules
        WHERE id = 'rule-manual-review'
           OR data ->> 'conditionKey' = 'manual_review'
        """
    )


def downgrade() -> None:
    # Existing null review rows cannot be made non-null without data loss.
    # Keep the migration reversible for databases that contain no such rows.
    op.execute(
        "ALTER TABLE permission_requests ALTER COLUMN subject_id SET NOT NULL"
    )
