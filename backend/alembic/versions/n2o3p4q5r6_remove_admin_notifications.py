"""Remove the retired admin notification storage."""
from alembic import op


revision = "n2o3p4q5r6"
down_revision = "m1n2o3p4q5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS notifications")


def downgrade() -> None:
    # Restores the previous schema; deleted inbox records cannot be recovered.
    op.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id text PRIMARY KEY,
            created_at timestamptz NOT NULL,
            data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC)")
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_notifications_unread_created_at
        ON notifications (created_at DESC)
        WHERE COALESCE(data->>'read', 'false') <> 'true'
    """)
